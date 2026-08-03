// 延迟监控编排层：拉数据 → 建模型 → 交给 chart.js / stats.js 渲染。
//
// 模型在这里用纯函数一次算清并当参数传下去。此前 latencyRange / latencyLossSeries
// 是 renderChart 的副产品，而 renderChart 有早返回分支——返回时统计读到的是上一轮
// 的口径，画面与数字对不上且不报错。子模块一律不得反向 import 本文件（循环依赖 + TDZ）。

import { $, bindPopover, on, setText } from "../../core/dom.js";
import { formatDateValue, formatSpan } from "../../core/format.js";
import { getJSON, logFetchError } from "../../core/http.js";
import { onThemeChange } from "../../core/theme.js";
import { renderLatencyChart } from "./chart.js";
import { latencyPalette, targetColor } from "./palette.js";
import { renderLatencyStats } from "./stats.js";

// 单桶丢包率超过这个百分比即计入「异常区间 / 异常时长」
const LOSS_THRESHOLD = 1.0;

/** @type {any} */
let latencyData = null;
/** @type {any} */
let latencyModel = null;
let latencyZoom = { start: 0, end: 100 };
let statsRaf = null;

/** 已选中的目标标签；空集合意味着「还没初始化过」，见 syncTargetPills */
const activeTags = new Set();
let renderedTagKey = "";

// 快捷范围：24h / 7d / custom。custom 时以下两个日期串生效
let rangeMode = "24h";
/** @type {string|null} */
let startDate = null;
/** @type {string|null} */
let endDate = null;

export function initLatency() {
  onThemeChange(renderAll);
  bindControls();
  fetchLatency();
}

/** 定时刷新入口：沿用当前选择的范围，不把用户拽回最近 24 小时 */
export function refreshLatency() {
  fetchLatency();
}

/* -------------------------------------------------------------------------- */
/* 控件                                                                        */
/* -------------------------------------------------------------------------- */

function bindControls() {
  const startEl = /** @type {HTMLInputElement} */ ($("latency-start"));
  const endEl = /** @type {HTMLInputElement} */ ($("latency-end"));
  const more = bindPopover("lat-more", "lat-more-pop");

  on("lat-range-24h", "click", () => selectRange("24h"));
  on("lat-range-7d", "click", () => selectRange("7d"));
  // 「自定义」本身不改范围，只把日期输入摊开——真正生效在弹层里的「查询」
  on("lat-range-custom", "click", () => more?.setOpen(true));

  on("latency-query", "click", () => {
    const { start, end } = normalizeRange(startEl?.value, endEl?.value);
    if (!start || !end) {
      selectRange("24h");
      return;
    }
    if (startEl) startEl.value = start;
    if (endEl) endEl.value = end;
    applyCustomRange(start, end);
  });

  on("latency-recent", "click", () => selectRange("24h"));
  on("latency-reset", "click", () => selectRange("24h"));

  on("date-prev", "click", () => shiftDays(-1));
  on("date-next", "click", () => shiftDays(1));

  on("show-loss", "change", renderAll);
  on("show-max", "change", renderAll);
  on("show-avg", "change", renderAll);
}

/** @param {"24h"|"7d"} mode */
function selectRange(mode) {
  const startEl = /** @type {HTMLInputElement} */ ($("latency-start"));
  const endEl = /** @type {HTMLInputElement} */ ($("latency-end"));
  rangeMode = mode;
  if (mode === "24h") {
    startDate = null;
    endDate = null;
    if (startEl) startEl.value = "";
    if (endEl) endEl.value = "";
  } else {
    const today = new Date();
    startDate = formatDateValue(shiftDate(today, -6));
    endDate = formatDateValue(today);
    if (startEl) startEl.value = startDate;
    if (endEl) endEl.value = endDate;
  }
  latencyZoom = { start: 0, end: 100 };
  fetchLatency();
}

/** @param {string} start @param {string} end */
function applyCustomRange(start, end) {
  rangeMode = "custom";
  startDate = start;
  endDate = end;
  latencyZoom = { start: 0, end: 100 };
  fetchLatency();
}

/** 前后一天：无自定义区间时以今天为基准起步 @param {number} offset */
function shiftDays(offset) {
  const startEl = /** @type {HTMLInputElement} */ ($("latency-start"));
  const endEl = /** @type {HTMLInputElement} */ ($("latency-end"));
  const today = formatDateValue(new Date());
  const current = normalizeRange(startEl?.value, endEl?.value);
  const nextStart = shiftDateValue(current.start || today, offset);
  const nextEnd = shiftDateValue(current.end || today, offset);
  // 越过今天就没有数据可查了，退回最近 24 小时而不是给出一段空区间
  if (nextEnd > today) {
    selectRange("24h");
    return;
  }
  if (startEl) startEl.value = nextStart;
  if (endEl) endEl.value = nextEnd;
  applyCustomRange(nextStart, nextEnd);
}

function syncRangeButtons() {
  const map = {
    "lat-range-24h": rangeMode === "24h",
    "lat-range-7d": rangeMode === "7d",
    "lat-range-custom": rangeMode === "custom",
  };
  for (const [id, active] of Object.entries(map)) {
    $(id)?.classList.toggle("is-active", active);
  }
}

/** 目标筛选胶囊：目标集合变化时才重建，避免每分钟刷新都闪一次 */
function syncTargetPills(targets) {
  const container = $("lat-target-pills");
  if (!container) return;
  const key = targets.map((t) => t.tag).join("\u0000");
  if (key === renderedTagKey) return;
  renderedTagKey = key;

  // 新出现的目标（例如客户端上报的 client:*）默认参与统计
  targets.forEach((t) => activeTags.add(t.tag));

  container.innerHTML = "";
  targets.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lat-target-pill";
    btn.dataset.tag = t.tag;
    const dot = document.createElement("span");
    dot.className = "lat-dot";
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(t.tag));
    btn.addEventListener("click", () => {
      // 至少留一个目标，全关掉只会得到一张空图
      if (activeTags.has(t.tag) && activeTags.size > 1) {
        activeTags.delete(t.tag);
      } else {
        activeTags.add(t.tag);
      }
      latencyZoom = { start: 0, end: 100 };
      renderAll();
    });
    container.appendChild(btn);
  });
}

/* -------------------------------------------------------------------------- */
/* 数据                                                                        */
/* -------------------------------------------------------------------------- */

async function fetchLatency() {
  try {
    let url = "/api/latency";
    if (rangeMode !== "24h" && startDate && endDate) {
      url += `?start=${startDate}&end=${endDate}`;
    }
    latencyData = await getJSON(url);
    syncTargetPills(latencyData?.targets || []);
    renderAll();
  } catch (e) {
    logFetchError("获取延迟数据失败:", e);
  }
}

function renderAll() {
  syncRangeButtons();
  if (!latencyData) return;
  latencyModel = buildLatencyModel(latencyData, activeTags);

  renderLatencyChart(latencyModel, {
    showLoss: checked("show-loss"),
    showMax: checked("show-max"),
    showAvg: checked("show-avg"),
    zoom: latencyZoom,
    onZoom: (zoom) => {
      latencyZoom = zoom;
      scheduleStats();
    },
  });

  setText(
    "lat-pop-note",
    `当前粒度 ${latencyModel.granularity} 分钟 · 跨度越大粒度越粗（约 1440 点）`,
  );
  renderLatencyStats(latencyModel, zoomRange(), buildCtx());
  syncTargetPillState();
}

function buildCtx() {
  return {
    rangeLabel: rangeLabel(),
    rangeText: rangeText(),
    showLoss: checked("show-loss"),
    // 指标条的口径跟着缩放窗口走（见 zoomRange），标签却写死查询范围时，
    // 缩到 15 分钟仍显示「24h 平均」——数字对不上标题，只能是标签让步
    zoomed: latencyZoom.start > 0.01 || latencyZoom.end < 99.99,
  };
}

// 目标胶囊的圆点与图表同色，选中态跟随 activeTags
function syncTargetPillState() {
  const container = $("lat-target-pills");
  if (!container) return;
  const colors = latencyPalette();
  const order = latencyModel?.targets || [];
  container.querySelectorAll(".lat-target-pill").forEach((el) => {
    const pill = /** @type {HTMLElement} */ (el);
    const tag = pill.dataset.tag || "";
    pill.classList.toggle("is-active", activeTags.has(tag));
    const dot = /** @type {HTMLElement|null} */ (pill.querySelector(".lat-dot"));
    const idx = order.findIndex((t) => t.tag === tag);
    if (dot && idx >= 0) dot.style.background = targetColor(colors, idx);
  });
}

function scheduleStats() {
  if (statsRaf) return;
  statsRaf = requestAnimationFrame(() => {
    statsRaf = null;
    if (!latencyModel) return;
    renderLatencyStats(latencyModel, zoomRange(), buildCtx());
  });
}

/* -------------------------------------------------------------------------- */
/* 模型                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 把接口原始数据折算成 chart / stats 共用的一份口径。纯函数，无副作用。
 * @param {any} data @param {Set<string>} tags
 */
function buildLatencyModel(data, tags) {
  const granularity = Math.max(1, Number(data?.granularity) || 1);
  const stepMs = granularity * 60000;
  // 缺口判定：间隔超过「一个粒度桶 + 90s 余量」才算停采。余量吸收采集节奏漂移
  // 导致的单桶假空洞（采样未对齐整分钟，偶尔某分钟落 0 个样本但 ping 并未真丢）
  const gapMs = stepMs + 90000;
  const targets = Array.isArray(data?.targets) ? data.targets : [];

  const series = targets
    .map((t, idx) => ({ tag: t.tag, idx, points: t.points || [] }))
    .filter((t) => tags.has(t.tag))
    .map((t) => ({ ...t, line: buildLine(t.points, stepMs, gapMs) }));

  const lossSeries = buildLossSeries(series, stepMs, gapMs);

  return {
    granularity,
    stepMs,
    gapMs,
    lossThresholdPct: LOSS_THRESHOLD,
    targets,
    series,
    lossSeries,
    gapAreas: buildGapAreas(series, stepMs, gapMs),
    lossAreas: buildLossAreas(lossSeries, LOSS_THRESHOLD, stepMs),
    timeRange: buildTimeRange(series),
    sampleCount: series.reduce((n, s) => n + s.points.length, 0),
  };
}

// 缺口处插入 null 点让折线断开，避免直线跨越无数据时段造成误导
function buildLine(points, stepMs, gapMs) {
  const line = [];
  let prevTs = null;
  points.forEach((p) => {
    const ts = p.ts * 1000;
    if (prevTs !== null && ts - prevTs > gapMs) {
      line.push({ value: [prevTs + stepMs, null], isGap: true });
    }
    const rtt = p.rtt_ms === null || p.rtt_ms === undefined ? null : p.rtt_ms;
    line.push([ts, rtt]);
    prevTs = ts;
  });
  return line;
}

// 所有选中目标在同一时间桶上的发包/丢包相加，得到全链路的丢包率序列
function buildLossSeries(series, stepMs, gapMs) {
  /** @type {Map<number, {sent: number, lost: number}>} */
  const map = new Map();
  series.forEach((s) => {
    s.points.forEach((p) => {
      const row = map.get(p.ts) || { sent: 0, lost: 0 };
      row.sent += p.sent || 0;
      row.lost += p.lost || 0;
      map.set(p.ts, row);
    });
  });

  const points = Array.from(map.entries())
    .map(([ts, v]) => ({
      ts: ts * 1000,
      loss: v.sent > 0 ? (v.lost / v.sent) * 100 : null,
      sent: v.sent,
      lost: v.lost,
    }))
    .sort((a, b) => a.ts - b.ts);

  // 阈值须与折线一致，否则丢包序列与延迟曲线的断点位置对不上；同时避免缺口前的
  // 高丢包点把整段缺口一并计入异常时长
  const filled = [];
  points.forEach((p) => {
    const prev = filled.length ? filled[filled.length - 1] : null;
    if (prev && p.ts - prev.ts > gapMs) {
      filled.push({ ts: prev.ts + stepMs, loss: null, sent: 0, lost: 0, gap: true });
    }
    filled.push(p);
  });
  return filled;
}

// 合并所有目标的时间线找无数据缺口（采集器停采对所有目标同时生效）
function buildGapAreas(series, stepMs, gapMs) {
  const tsSet = new Set();
  series.forEach((s) => s.points.forEach((p) => tsSet.add(p.ts * 1000)));
  const list = Array.from(tsSet).sort((a, b) => a - b);
  const areas = [];
  for (let i = 1; i < list.length; i++) {
    const span = list[i] - list[i - 1];
    if (span > gapMs) {
      // 两端贴齐相邻的真实数据点，完整覆盖缺口
      areas.push([
        { xAxis: list[i - 1], name: `无数据 ${formatSpan(span - stepMs)}` },
        { xAxis: list[i] },
      ]);
    }
  }
  return areas;
}

// 连续超阈值的丢包段合并成一个色块，标签写明丢了多少、持续了多久
function buildLossAreas(points, threshold, stepMs) {
  const areas = [];
  let start = null;
  let peak = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const over = p.loss !== null && p.loss >= threshold;
    if (over) {
      if (start === null) start = p.ts;
      if (p.loss > peak) peak = p.loss;
    }
    const isLast = i === points.length - 1;
    if (start !== null && (!over || isLast)) {
      const end = over && isLast ? p.ts : points[i - 1].ts;
      // 每个超阈值的桶各占一个粒度宽度，所以时长是「末桶 − 首桶 + 一个桶」，
      // 与指标条的「异常时长」口径一致（少加这一格会比指标条少一分钟）。
      // 右端同样要推到末桶的桶尾：此前区间画到 end（末桶的桶头），单桶丢包
      // 宽度为 0，最严重的「整分钟全丢」反倒一个色块都画不出来
      // 单桶丢包在 24h 视图里可能散落几十处，逐个挂标签会糊成一片文字；色块
      // 本身已经点明位置，具体数值交给 tooltip，只有连续多桶才值得写出来
      const sustained = end > start;
      areas.push([
        {
          xAxis: start,
          name: sustained
            ? `丢包 ${formatLossPct(peak)} · ${formatSpan(end - start + stepMs)}`
            : "",
        },
        { xAxis: end + stepMs },
      ]);
      start = null;
      peak = 0;
    }
  }
  return areas;
}

/** 色块标签里的丢包率：小数点只在个位数时有意义，100% 要写成整数 */
function formatLossPct(pct) {
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function buildTimeRange(series) {
  let min = Infinity;
  let max = -Infinity;
  series.forEach((s) => {
    s.points.forEach((p) => {
      const ts = p.ts * 1000;
      if (ts < min) min = ts;
      if (ts > max) max = ts;
    });
  });
  if (min === Infinity || max === -Infinity) return null;
  return { min, max };
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/** 统计口径跟随图表的缩放窗口，而不是永远按整段区间算 */
function zoomRange() {
  const range = latencyModel?.timeRange;
  if (!range) return null;
  const span = range.max - range.min;
  if (span <= 0) return null;
  return {
    start: range.min + (span * latencyZoom.start) / 100,
    end: range.min + (span * latencyZoom.end) / 100,
  };
}

function rangeLabel() {
  if (rangeMode === "24h") return "24h";
  if (rangeMode === "7d") return "7 天";
  return "区间";
}

function rangeText() {
  if (rangeMode === "24h") return "最近 24 小时";
  if (rangeMode === "7d") return "最近 7 天";
  return startDate && endDate ? `${startDate} — ${endDate}` : "自定义区间";
}

/** @param {string} id */
function checked(id) {
  return /** @type {HTMLInputElement} */ ($(id))?.checked ?? false;
}

function normalizeRange(startVal, endVal) {
  let start = startVal ? String(startVal).trim() : "";
  let end = endVal ? String(endVal).trim() : "";
  if (!start && !end) return { start: null, end: null };
  if (!start) start = end;
  if (!end) end = start;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

/** @param {Date} date @param {number} offsetDays */
function shiftDate(date, offsetDays) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + offsetDays);
  return next;
}

/** @param {string} dateStr @param {number} offsetDays */
function shiftDateValue(dateStr, offsetDays) {
  return formatDateValue(shiftDate(new Date(dateStr), offsetDays));
}
