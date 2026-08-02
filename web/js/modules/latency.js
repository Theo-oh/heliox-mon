// 延迟监控：ECharts 折线 + 丢包率副轴 + 无数据/异常区间标注

import { $, escapeHtml, on } from "../core/dom.js";
import {
  formatDateValue,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../core/format.js";
import { getJSON, logFetchError } from "../core/http.js";
import {
  hexToRgba,
  isLight,
  onThemeChange,
  palette,
  tooltipColors,
} from "../core/theme.js";
import { echarts } from "../core/vendor.js";

/** @type {any} */
let latencyChart = null;
let latencyData = null;
let latencyZoom = { start: 0, end: 100 };
let latencyRange = null;
let latencyStatsRaf = null;
let latencyLossSeries = [];
const latencyLossThreshold = 1.0;

// 多目标的分类色板。首色是设计稿指定的延迟序列色（--accent-blue），
// 其余为增补目标准备；末两色不在语义 token 里，属纯分类用途。
// ⚠️ 必须在渲染时调用，不能在模块顶层求值——主题切换后要拿到新色。
function latencyPalette() {
  const pal = palette();
  return [pal.info, pal.ok, pal.warn, pal.purple, "#64d2ff", "#ff375f"];
}

/** @param {string[]} colors @param {number} idx */
function targetColor(colors, idx) {
  return colors[idx % colors.length];
}

// 延迟查询参数
let latencyStartDate = null;
let latencyEndDate = null;
let activeTags = new Set(); // 选中的运营商标签
let filtersInitialized = false;

export function initLatency() {
  onThemeChange(renderLatencyChart);
  bindLatencyControls();
  fetchLatency();
}

/** 定时刷新入口：有自定义时间范围就沿用，否则回到最近 24 小时 */
export function refreshLatency() {
  if (latencyStartDate && latencyEndDate) {
    fetchLatency(latencyStartDate, latencyEndDate);
  } else {
    fetchLatency();
  }
}

function bindLatencyControls() {
  const latencyEndEl = /** @type {HTMLInputElement} */ ($("latency-end"));
  const latencyStartEl = /** @type {HTMLInputElement} */ ($("latency-start"));

  // 设置默认日期（今天）
  const today = formatDateValue(new Date());
  if (latencyEndEl) latencyEndEl.value = "";
  if (latencyStartEl) latencyStartEl.value = "";
  latencyStartDate = null;
  latencyEndDate = null;

  // 查询按钮
  on("latency-query", "click", () => {
    const { start, end } = normalizeRange(
      latencyStartEl?.value,
      latencyEndEl?.value,
    );

    if (!start && !end) {
      latencyStartDate = null;
      latencyEndDate = null;
      fetchLatency();
      return;
    }

    if (latencyStartEl) latencyStartEl.value = start;
    if (latencyEndEl) latencyEndEl.value = end;
    latencyStartDate = start;
    latencyEndDate = end;
    latencyZoom = { start: 0, end: 100 };
    fetchLatency(start, end);
  });

  on("latency-recent", "click", () => {
    if (latencyStartEl) latencyStartEl.value = "";
    if (latencyEndEl) latencyEndEl.value = "";
    latencyStartDate = null;
    latencyEndDate = null;
    latencyZoom = { start: 0, end: 100 };
    fetchLatency();
  });

  // 前一天/后一天
  if (latencyEndEl) {
    on("date-prev", "click", () => {
      const { start, end } = normalizeRange(
        latencyStartEl?.value,
        latencyEndEl?.value,
      );
      const newStart = shiftDateValue(start || today, -1);
      const newEnd = shiftDateValue(end || today, -1);

      if (latencyStartEl) latencyStartEl.value = newStart;
      latencyEndEl.value = newEnd;
      latencyStartDate = newStart;
      latencyEndDate = newEnd;
      latencyZoom = { start: 0, end: 100 };
      fetchLatency(newStart, newEnd);
    });

    on("date-next", "click", () => {
      const { start, end } = normalizeRange(
        latencyStartEl?.value,
        latencyEndEl?.value,
      );
      const newStart = shiftDateValue(start || today, 1);
      const newEnd = shiftDateValue(end || today, 1);
      if (newEnd > today) {
        if (latencyStartEl) latencyStartEl.value = "";
        latencyEndEl.value = "";
        latencyStartDate = null;
        latencyEndDate = null;
        latencyZoom = { start: 0, end: 100 };
        fetchLatency();
        return;
      }

      if (latencyStartEl) latencyStartEl.value = newStart;
      latencyEndEl.value = newEnd;
      latencyStartDate = newStart;
      latencyEndDate = newEnd;
      latencyZoom = { start: 0, end: 100 };
      fetchLatency(newStart, newEnd);
    });
  }

  // 显示选项事件监听
  on("show-max", "change", renderLatencyChart);
  on("show-avg", "change", renderLatencyChart);
  on("show-loss", "change", renderLatencyChart);

  // 重置按钮
  on("latency-reset", "click", () => {
    if (latencyStartEl) latencyStartEl.value = "";
    if (latencyEndEl) latencyEndEl.value = "";
    latencyStartDate = null;
    latencyEndDate = null;
    latencyZoom = { start: 0, end: 100 };
    fetchLatency();
  });
}

function setLatencyRecentActive(active) {
  const recentBtn = $("latency-recent");
  if (!recentBtn) return;
  recentBtn.classList.toggle("is-active", active);
}

function normalizeRange(startVal, endVal) {
  let start = startVal ? String(startVal).trim() : "";
  let end = endVal ? String(endVal).trim() : "";

  if (!start && !end) {
    return { start: null, end: null };
  }

  if (!start && end) start = end;
  if (start && !end) end = start;

  if (start && end && start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  return { start, end };
}

function shiftDateValue(dateStr, offsetDays) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + offsetDays);
  return formatDateValue(date);
}

async function fetchLatency(start = null, end = null) {
  try {
    let url = "/api/latency";
    const range = normalizeRange(start, end);
    setLatencyRecentActive(!range.start && !range.end);
    if (range.start && range.end) {
      url += `?start=${range.start}&end=${range.end}`;
    }

    latencyData = await getJSON(url);

    // 显示粒度信息
    const granularityEl = $("latency-granularity");
    if (granularityEl && latencyData.granularity) {
      let label = `粒度: ${latencyData.granularity} 分钟`;
      if (!range.start && !range.end) {
        label += " · 最近24小时";
      }
      granularityEl.textContent = label;
    }

    // 初始化过滤器 (仅一次)
    if (!filtersInitialized && latencyData.targets) {
      renderFilterCheckboxes(latencyData.targets);
      filtersInitialized = true;
    }

    renderLatencyChart();
    scheduleLatencyStatsRender();
  } catch (e) {
    logFetchError("获取延迟数据失败:", e);
  }
}

function renderFilterCheckboxes(targets) {
  const container = $("target-filters");
  if (!container) return;

  const colors = latencyPalette();
  container.innerHTML = "";
  targets.forEach((t, idx) => {
    // 默认全选
    activeTags.add(t.tag);

    const label = document.createElement("label");
    label.className = "filter-pill";
    const dot = document.createElement("span");
    dot.className = "latency-target-dot";
    dot.style.background = targetColor(colors, idx);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.tag = t.tag;

    input.addEventListener("change", (e) => {
      if (/** @type {HTMLInputElement} */ (e.target).checked) {
        activeTags.add(t.tag);
      } else {
        activeTags.delete(t.tag);
      }
      renderLatencyChart();
      scheduleLatencyStatsRender();
    });

    label.appendChild(input);
    label.appendChild(dot);
    label.appendChild(document.createTextNode(" " + t.tag));
    container.appendChild(label);
  });
}

function renderLatencyChart() {
  if (!latencyData || !latencyData.targets) return;

  const showMax = /** @type {HTMLInputElement} */ ($("show-max"))?.checked ?? false;
  const showAvg = /** @type {HTMLInputElement} */ ($("show-avg"))?.checked ?? false;
  const showLoss = /** @type {HTMLInputElement} */ ($("show-loss"))?.checked ?? false;

  const chartEl = $("latency-chart");
  if (!chartEl || !echarts) return;

  if (!latencyChart) {
    latencyChart = echarts.init(chartEl, null, {
      renderer: "canvas",
      useDirtyRect: true,
    });
    window.addEventListener("resize", () => {
      if (latencyChart) latencyChart.resize();
    });
  }

  const pal = palette();
  const colors = latencyPalette();
  const tip = tooltipColors();
  const textColor = pal.text;
  const mutedColor = pal.muted;
  const borderColor = pal.border;
  const light = isLight();
  const gridLine = light ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.06)";
  const zoomBg = light ? "rgba(0, 0, 0, 0.08)" : "rgba(0, 0, 0, 0.2)";
  const zoomFill = hexToRgba(pal.info, light ? 0.25 : 0.2);
  // markPoint 标签底色：均值中性、最高走危险色、最低走健康色，各自压到半透明避免抢戏
  const labelAlpha = light ? 0.45 : 0.5;
  const avgLabelBg = hexToRgba(pal.muted, labelAlpha);
  const maxLabelBg = hexToRgba(pal.danger, labelAlpha);
  const minLabelBg = hexToRgba(pal.ok, labelAlpha);

  // 无数据缺口判定：间隔超过「一个粒度桶 + 90s 余量」才算停采。
  // 余量用于吸收采集节奏漂移导致的单桶假空洞（采样未对齐整分钟，偶尔某分钟落 0
  // 个样本但 ping 并未真丢）；细粒度下需连续缺 ≥2 分钟才标灰，粗粒度下真实的多分
  // 钟中断仍照常显示。
  const gapStepMs = Math.max(1, latencyData.granularity || 1) * 60000;
  const gapThresholdMs = gapStepMs + 90000;

  const series = latencyData.targets
    .map((target, idx) => {
      if (!activeTags.has(target.tag)) return null;
      const color = targetColor(colors, idx);
      const points = target.points || [];
      // 缺口处插入 null 点让折线断开，避免直线跨越无数据时段造成误导
      const data = [];
      let prevTs = null;
      points.forEach((p) => {
        const ts = p.ts * 1000;
        if (prevTs !== null && ts - prevTs > gapThresholdMs) {
          data.push({ value: [prevTs + gapStepMs, null], isGap: true });
        }
        data.push([
          ts,
          p.rtt_ms === null || p.rtt_ms === undefined ? null : p.rtt_ms,
        ]);
        prevTs = ts;
      });
      const stats = target.stats || {};
      const avg = stats.avg ?? 0;

      return {
        name: target.tag,
        type: "line",
        smooth: true,
        showSymbol: false,
        data,
        itemStyle: { color },
        lineStyle: { color, width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexToRgba(color, 0.28) },
            { offset: 1, color: "rgba(0,0,0,0)" },
          ]),
        },
        emphasis: { focus: "series" },
        markLine:
          showAvg && avg > 0
            ? {
                symbol: "none",
                lineStyle: {
                  type: "dashed",
                  color,
                  opacity: 0.65,
                },
                label: {
                  color: textColor,
                  backgroundColor: avgLabelBg,
                  borderRadius: 6,
                  padding: [3, 6],
                  formatter: ({ value }) => `${value.toFixed(1)}ms`,
                  position: "insideEndTop",
                },
                data: [{ yAxis: avg }],
              }
            : undefined,
        markPoint: showMax
          ? {
              symbol: "circle",
              symbolSize: 6,
              itemStyle: { color, opacity: 0.85 },
              label: {
                color: textColor,
                fontSize: 11,
                borderRadius: 6,
                padding: [2, 6],
                formatter: (param) => {
                  const v = Array.isArray(param.value)
                    ? param.value[param.value.length - 1]
                    : param.value;
                  if (v === null || v === undefined || Number.isNaN(v))
                    return "";
                  return `${Number(v).toFixed(1)}ms`;
                },
                position: "top",
                distance: 6,
              },
              data: [
                { type: "max", label: { backgroundColor: maxLabelBg } },
                { type: "min", label: { backgroundColor: minLabelBg } },
              ],
            }
          : undefined,
      };
    })
    .filter(Boolean);

  // 灰色区域标注无数据缺口；挂在第一个目标序列上即可全图显示
  const gapAreas = buildGapMarkAreas(latencyData.targets, gapThresholdMs);
  if (series.length && gapAreas.length) {
    series[0].markArea = {
      silent: true,
      itemStyle: {
        color: hexToRgba(pal.muted, 0.1),
      },
      label: {
        show: true,
        position: "insideTop",
        color: mutedColor,
        fontSize: 10,
      },
      data: gapAreas,
    };
  }

  latencyLossSeries = buildLossSeries(latencyData.targets);
  if (showLoss && latencyLossSeries.length) {
    series.push({
      name: "丢包率",
      type: "line",
      yAxisIndex: 1,
      smooth: true,
      showSymbol: false,
      data: latencyLossSeries.map((p) =>
        p.gap ? { value: [p.ts, null], isGap: true } : [p.ts, p.loss],
      ),
      itemStyle: { color: pal.danger },
      lineStyle: { color: pal.danger, width: 1.5 },
      areaStyle: { color: hexToRgba(pal.danger, 0.12) },
      emphasis: { focus: "series" },
      markArea: {
        silent: true,
        itemStyle: { color: hexToRgba(pal.warn, 0.07) },
        data: buildLossMarkAreas(latencyLossSeries, latencyLossThreshold),
      },
    });
  }

  latencyRange = getLatencyRange(series);
  const zoomStart = latencyZoom.start ?? 0;
  const zoomEnd = latencyZoom.end ?? 100;

  const option = {
    animation: false,
    grid: { left: 50, right: 24, top: 24, bottom: 54, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: tip.bg,
      borderColor: borderColor,
      textStyle: { color: textColor },
      axisPointer: { type: "cross", label: { color: textColor } },
      formatter: (params) => {
        const time = new Date(params[0].value[0]).toLocaleString("zh-CN");
        const rows = params
          .map((p) => {
            const value = Array.isArray(p.value) ? p.value[1] : p.value;
            const isGap = p.data && !Array.isArray(p.data) && p.data.isGap;
            const text =
              value === null || value === undefined
                ? isGap
                  ? "无数据"
                  : "丢包"
                : p.seriesName === "丢包率"
                  ? `${Number(value).toFixed(1)}%`
                  : `${Number(value).toFixed(1)} ms`;
            return `<span style=\"display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:50%;background:${p.color}\"></span>${escapeHtml(p.seriesName)}: ${text}`;
          })
          .join("<br/>");
        return `${time}<br/>${rows}`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: borderColor } },
      axisLabel: { color: mutedColor },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value",
        axisLine: { lineStyle: { color: borderColor } },
        axisLabel: { color: mutedColor, formatter: "{value} ms" },
        splitLine: { lineStyle: { color: gridLine } },
      },
      {
        type: "value",
        axisLine: { lineStyle: { color: borderColor } },
        axisLabel: { color: mutedColor, formatter: "{value}%" },
        splitLine: { show: false },
        min: 0,
        max: 100,
      },
    ],
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        start: zoomStart,
        end: zoomEnd,
      },
      {
        type: "slider",
        xAxisIndex: 0,
        height: 26,
        bottom: 10,
        start: zoomStart,
        end: zoomEnd,
        borderColor: borderColor,
        backgroundColor: zoomBg,
        fillerColor: zoomFill,
        handleSize: "120%",
        handleStyle: {
          color: pal.info,
          borderColor: borderColor,
        },
        textStyle: { color: mutedColor },
      },
    ],
    series,
  };

  if (!series.length) {
    option.graphic = [
      {
        type: "text",
        left: "center",
        top: "middle",
        style: { text: "暂无数据", fill: mutedColor, fontSize: 14 },
      },
    ];
  }

  latencyChart.setOption(option, true);
  bindLatencyZoom();
  scheduleLatencyStatsRender();
}

function renderLatencyStats() {
  const container = $("latency-stats");
  if (!container || !latencyData || !latencyData.targets) return;
  const range = getZoomRange();
  let totalCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let totalSent = 0;
  let totalLost = 0;
  const anomalyMinutes = computeLossAnomalyMinutes(
    latencyLossSeries,
    range,
    latencyLossThreshold,
    latencyData?.granularity,
  );

  const colors = latencyPalette();
  const targetCards = latencyData.targets
    .filter((t) => activeTags.has(t.tag))
    .map((t, idx) => {
      const stats = computeTargetStats(t.points || [], range);
      if (stats.count && stats.avg != null) {
        sum += stats.avg * stats.count;
        totalCount += stats.count;
      }
      if (stats.min != null && stats.min < min) min = stats.min;
      if (stats.max != null && stats.max > max) max = stats.max;
      totalSent += stats.sent;
      totalLost += stats.lost;

      const color = targetColor(colors, idx);
      return `
        <div class="latency-target-card">
          <div class="latency-target-header">
            <span class="latency-target-dot" style="background:${color}"></span>
            <span>${escapeHtml(t.tag)}</span>
          </div>
          <div class="latency-target-values">
            <span>均值 <strong>${formatNumber(stats.avg)}</strong>ms</span>
            <span>P95 <strong>${formatNumber(stats.p95)}</strong>ms</span>
            <span>抖动 <strong>${formatNumber(stats.jitter)}</strong>ms</span>
            <span>最小 <strong>${formatNumber(stats.min)}</strong>ms</span>
            <span>最大 <strong>${formatNumber(stats.max)}</strong>ms</span>
            <span>丢包 <strong>${formatPercent(stats.lossRate)}</strong></span>
          </div>
        </div>
      `;
    })
    .join("");

  const hasData = totalCount > 0;
  const avg = hasData ? sum / totalCount : null;
  if (min === Infinity) min = null;
  if (max === -Infinity) max = null;
  const lossRate = totalSent > 0 ? (totalLost / totalSent) * 100 : null;

  container.innerHTML = `
    <div class="latency-summary">
      <div class="latency-metric">
        <span class="label">平均延迟</span>
        <span class="value">${formatNumber(avg)}<small>ms</small></span>
      </div>
      <div class="latency-metric">
        <span class="label">最小延迟</span>
        <span class="value">${formatNumber(min)}<small>ms</small></span>
      </div>
      <div class="latency-metric">
        <span class="label">最大延迟</span>
        <span class="value">${formatNumber(max)}<small>ms</small></span>
      </div>
      <div class="latency-metric">
        <span class="label">丢包率</span>
        <span class="value">${formatPercent(lossRate)}</span>
      </div>
      <div class="latency-metric">
        <span class="label">异常时长</span>
        <span class="value">${formatDuration(anomalyMinutes)}</span>
      </div>
    </div>
    <div class="latency-targets">${targetCards}</div>
  `;
}

function scheduleLatencyStatsRender() {
  if (latencyStatsRaf) return;
  latencyStatsRaf = requestAnimationFrame(() => {
    latencyStatsRaf = null;
    renderLatencyStats();
  });
}

function getLatencyRange(series) {
  let min = Infinity;
  let max = -Infinity;
  series.forEach((s) => {
    (s.data || []).forEach((point) => {
      const ts = Array.isArray(point) ? point[0] : point.value?.[0];
      if (ts === undefined) return;
      if (ts < min) min = ts;
      if (ts > max) max = ts;
    });
  });
  if (min === Infinity || max === -Infinity) return null;
  return { min, max };
}

function buildLossSeries(targets) {
  const map = new Map();
  targets
    .filter((t) => activeTags.has(t.tag))
    .forEach((t) => {
      (t.points || []).forEach((p) => {
        if (!map.has(p.ts)) {
          map.set(p.ts, { sent: 0, lost: 0 });
        }
        const row = map.get(p.ts);
        row.sent += p.sent || 0;
        row.lost += p.lost || 0;
      });
    });

  const points = Array.from(map.entries())
    .map(([ts, v]) => ({
      ts: ts * 1000,
      loss: v.sent > 0 ? (v.lost / v.sent) * 100 : null,
    }))
    .sort((a, b) => a.ts - b.ts);

  // 缺口处插入 null 断点，同时避免缺口前的高丢包点把整段缺口计入异常时长。
  // 阈值须与折线一致（一个粒度桶 + 90s 余量），避免丢包序列与延迟曲线断点不一致
  const stepMs = Math.max(1, latencyData?.granularity || 1) * 60000;
  const thresholdMs = stepMs + 90000;
  const filled = [];
  points.forEach((p) => {
    const prev = filled.length ? filled[filled.length - 1] : null;
    if (prev && p.ts - prev.ts > thresholdMs) {
      filled.push({ ts: prev.ts + stepMs, loss: null, gap: true });
    }
    filled.push(p);
  });
  return filled;
}

// 合并所有目标的时间线找无数据缺口（采集器停采对所有目标同时生效）
function buildGapMarkAreas(targets, thresholdMs) {
  const tsSet = new Set();
  targets.forEach((t) => {
    (t.points || []).forEach((p) => tsSet.add(p.ts * 1000));
  });
  const tsList = Array.from(tsSet).sort((a, b) => a - b);
  const areas = [];
  for (let i = 1; i < tsList.length; i++) {
    if (tsList[i] - tsList[i - 1] > thresholdMs) {
      // 灰色区域两端贴齐相邻真实数据点，完整覆盖缺口（不再往内缩一格）
      areas.push([
        { xAxis: tsList[i - 1], name: "无数据" },
        { xAxis: tsList[i] },
      ]);
    }
  }
  return areas;
}

function buildLossMarkAreas(points, threshold) {
  if (!points.length) return [];
  const areas = [];
  let start = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const over = p.loss !== null && p.loss >= threshold;
    if (over && start === null) {
      start = p.ts;
    }
    const isLast = i === points.length - 1;
    if ((start !== null && !over) || (start !== null && isLast)) {
      const end = over && isLast ? p.ts : points[i - 1].ts;
      if (end > start) {
        areas.push([{ xAxis: start }, { xAxis: end }]);
      }
      start = null;
    }
  }
  return areas;
}

function getZoomRange() {
  if (!latencyRange) return null;
  const span = latencyRange.max - latencyRange.min;
  if (span <= 0) return null;
  const start = latencyRange.min + (span * latencyZoom.start) / 100;
  const end = latencyRange.min + (span * latencyZoom.end) / 100;
  return { start, end };
}

function computeLossAnomalyMinutes(points, range, threshold, granularity) {
  if (!points || points.length === 0) return null;
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  let totalMs = 0;
  const defaultStep = (granularity || 1) * 60 * 1000;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ts = p.ts;
    if (start && ts < start) continue;
    if (end && ts > end) continue;
    const over = p.loss !== null && p.loss >= threshold;
    if (!over) continue;

    const next = points[i + 1];
    const delta = next ? next.ts - ts : defaultStep;
    totalMs += Math.max(0, delta);
  }

  return totalMs / 60000;
}

function computeTargetStats(points, range) {
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let sent = 0;
  let lost = 0;

  const validRtts = [];
  // mdev：ping 实测抖动（单次探测内标准差），更标准且经聚合仍有效，优先使用
  let mdevSum = 0;
  let mdevCount = 0;
  // 相邻采样差：仅在缺少 mdev 的旧数据时回退使用
  let deltaSum = 0;
  let deltaCount = 0;
  let prevRtt = null;

  const start = range?.start ?? null;
  const end = range?.end ?? null;

  points.forEach((p) => {
    const ts = p.ts * 1000;
    if (start && ts < start) return;
    if (end && ts > end) return;
    if (p.rtt_ms !== null && p.rtt_ms !== undefined) {
      sum += p.rtt_ms;
      count += 1;
      validRtts.push(p.rtt_ms);

      // min 优先用服务端真实最小 RTT，回退到本点平均值
      const minCandidate =
        p.min_rtt !== null && p.min_rtt !== undefined ? p.min_rtt : p.rtt_ms;
      if (minCandidate < min) min = minCandidate;
      if (p.rtt_ms > max) max = p.rtt_ms;

      // 抖动：优先累加服务端 mdev
      if (p.jitter !== null && p.jitter !== undefined) {
        mdevSum += p.jitter;
        mdevCount += 1;
      }
      if (prevRtt !== null) {
        deltaSum += Math.abs(p.rtt_ms - prevRtt);
        deltaCount += 1;
      }
      prevRtt = p.rtt_ms;
    } else {
      // 缺失点（例如超时）会打断抖动序列
      prevRtt = null;
    }
    if (p.sent !== undefined && p.sent !== null) {
      sent += p.sent;
      lost += p.lost || 0;
    }
  });

  let p95 = null;
  if (validRtts.length > 0) {
    validRtts.sort((a, b) => a - b);
    const idx = Math.floor(validRtts.length * 0.95);
    p95 = validRtts[idx];
  }

  const jitter = mdevCount
    ? mdevSum / mdevCount
    : deltaCount
      ? deltaSum / deltaCount
      : null;

  return {
    avg: count ? sum / count : null,
    p95: p95,
    jitter: jitter,
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
    count,
    sent,
    lost,
    lossRate: sent ? (lost / sent) * 100 : null,
  };
}

function bindLatencyZoom() {
  if (!latencyChart || latencyChart.__zoomBound) return;
  latencyChart.on("dataZoom", (evt) => {
    const batch = evt?.batch?.[0];
    if (
      batch &&
      typeof batch.start === "number" &&
      typeof batch.end === "number"
    ) {
      latencyZoom = { start: batch.start, end: batch.end };
      scheduleLatencyStatsRender();
    }
  });
  latencyChart.__zoomBound = true;
}
