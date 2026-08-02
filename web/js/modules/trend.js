// 历史趋势：近 6 个月柱状图 / 近 30 天与计费周期折线图

import { $, on, setHtml, setText } from "../core/dom.js";
import { niceCeil } from "../core/format.js";
import { getJSON, logFetchError } from "../core/http.js";
import {
  hexToRgba,
  isLight,
  onThemeChange,
  palette,
  tooltipColors,
} from "../core/theme.js";
import { Chart } from "../core/vendor.js";

const GB = 1024 * 1024 * 1024;

/** @type {any} */
let trendChart = null;
let trendChartType = "bar";
let trendMonthlyData = null;
let trendDailyData = null;
let trendCycleData = null;
let trendRange = "monthly"; // monthly | 30d | cycle
let trendView = "total"; // detail | total

export function initTrend() {
  setupTrendToggle();
  onThemeChange(renderTrendChart);
  refreshMonthlyTrend();
}

/** 定时刷新入口：月度视图的数据由 refreshMonthlyTrend 单独按小时刷新 */
export function refreshTrend() {
  if (trendRange === "30d" || trendRange === "cycle") {
    fetchDailyTrend(trendRange);
  }
}

export async function refreshMonthlyTrend() {
  try {
    trendMonthlyData = await getJSON("/api/traffic/monthly");

    // 空数据保护
    if (!trendMonthlyData || !Array.isArray(trendMonthlyData)) {
      console.warn("月度趋势数据为空");
      return;
    }

    renderTrendChart();
  } catch (e) {
    logFetchError("获取月度趋势失败:", e);
  }
}

/** @param {string} id @param {boolean} active */
function setSegState(id, active) {
  const el = $(id);
  if (el) el.classList.toggle("is-active", active);
}

function updateTrendToggleState() {
  setSegState("trend-range-month", trendRange === "monthly");
  setSegState("trend-range-30d", trendRange === "30d");
  setSegState("trend-range-cycle", trendRange === "cycle");
  setSegState("trend-total", trendView === "total");
  setSegState("trend-detail", trendView === "detail");

  // 总计/详细只对月度柱状图有意义，切走时连同那道竖分隔线一起收掉
  const monthly = trendRange === "monthly";
  for (const id of ["trend-view-sep", "trend-total", "trend-detail"]) {
    const el = $(id);
    if (el) el.hidden = !monthly;
  }
}

// 区间内的量级由总量定档，上下行/日均/峰值跟着用同一单位，读数才好横向比较
/** @param {number} gb @returns {{unit: string, scale: number}} */
function pickTrendUnit(gb) {
  if (gb >= 1024) return { unit: "TB", scale: 1 / 1024 };
  if (gb >= 1) return { unit: "GB", scale: 1 };
  return { unit: "MB", scale: 1024 };
}

/** @param {number} gb @param {{unit: string, scale: number}} u */
function fmtInUnit(gb, u) {
  const v = gb * u.scale;
  return v >= 100 ? v.toFixed(1) : v.toFixed(2);
}

/**
 * Y 轴刻度：量纲由轴顶定档，只有顶端那格带单位（`120 GB / 90 / 60 / 30 / 0`）。
 * @param {number} value @param {number|null} axisMax 均为 GB
 */
function formatTrendAxis(value, axisMax) {
  const u = pickTrendUnit(axisMax || value || 1);
  const v = value * u.scale;
  const text = v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1);
  return value === axisMax ? `${text} ${u.unit}` : text;
}

/**
 * 指标条：区间总量 / 上行·下行 / 均值 / 峰值 / 今日徽标。
 * 月度与日视图共用同一条，只有均值与峰值的标签口径不同。
 * @param {{sum:number, tx:number, rx:number, avg:number, avgLabel:string,
 *          peak:number, peakLabel:string, today?:number}} m 单位一律 GB
 */
function renderTrendMetrics(m) {
  const u = pickTrendUnit(m.sum);

  setText("trend-sum", fmtInUnit(m.sum, u));
  setText("trend-sum-unit", u.unit);
  setText("trend-tx", fmtInUnit(m.tx, u));
  setText("trend-rx", fmtInUnit(m.rx, u));
  setText("trend-txrx-unit", u.unit);

  // 日均/峰值比总量小一两个数量级，各自定档才不会显示成 0.03
  const avgUnit = pickTrendUnit(m.avg);
  setText("trend-avg", fmtInUnit(m.avg, avgUnit));
  setText("trend-avg-unit", avgUnit.unit);
  setText("trend-avg-label", m.avgLabel);

  const peakUnit = pickTrendUnit(m.peak);
  setText("trend-peak", fmtInUnit(m.peak, peakUnit));
  setText("trend-peak-unit", peakUnit.unit);
  setText("trend-peak-label", m.peakLabel);

  const badge = $("trend-today-badge");
  if (badge) badge.hidden = m.today === undefined;
  if (m.today !== undefined) {
    const todayUnit = pickTrendUnit(m.today);
    setText(
      "trend-today",
      `今日 ${fmtInUnit(m.today, todayUnit)} ${todayUnit.unit}`,
    );
  }
}

async function fetchDailyTrend(rangeType) {
  const range = rangeType === "cycle" ? "cycle" : "30d";
  try {
    const data = await getJSON(`/api/traffic/daily?range=${range}`);

    // 新装机器这个接口返回 null。归一成空数组走「无数据」分支画一张空图，
    // 而不是直接 return——那样分段控件已经切到「近30天」，图上却还留着月度柱状图，
    // 指标条也仍是「月均 / 峰值 03月」，比空图更容易误读
    const sorted = Array.isArray(data)
      ? data.slice().sort((a, b) => a.date.localeCompare(b.date))
      : [];

    if (range === "cycle") {
      trendCycleData = sorted;
    } else {
      trendDailyData = sorted;
    }

    renderTrendChart();
  } catch (e) {
    logFetchError("获取每日趋势失败:", e);
  }
}

function renderTrendChart() {
  const pal = palette();
  let labels = [];
  let datasets = [];
  let legendHtml = "";
  let chartType = "bar";
  let tooltipCallbacks = {
    label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(2)} GB`,
  };
  let tickCallback = null;
  let trendAvgAnnotation = null;
  let trendMaxAnnotation = null;
  let trendMaxLabelAnnotation = null;
  let trendYMax = null;

  if (trendRange === "monthly") {
    if (!trendMonthlyData) return;

    updateTrendToggleState();

    labels = trendMonthlyData.map((d) => {
      const parts = d.month.split("-");
      return parts[1] + "月";
    });
    // total_gb 是后端 toFixed 过的字符串，只能当刻度文案用；算数一律走 total（字节）
    const totalLabels = trendMonthlyData.map((d) => d.total_gb);
    const monthTotals = trendMonthlyData.map((d) => d.total / GB);

    const sumMonths = monthTotals.reduce((a, b) => a + b, 0);
    const peakIdx = monthTotals.indexOf(Math.max(...monthTotals));
    // 月度视图没有「今日」这个点，today 留空徽标就不出现
    renderTrendMetrics({
      sum: sumMonths,
      tx: trendMonthlyData.reduce((a, d) => a + d.total_tx / GB, 0),
      rx: trendMonthlyData.reduce((a, d) => a + d.total_rx / GB, 0),
      avg: sumMonths / (monthTotals.length || 1),
      avgLabel: "月均",
      peak: monthTotals[peakIdx] ?? 0,
      peakLabel: `峰值 ${labels[peakIdx] ?? "--"}`,
    });

    if (trendView === "detail") {
      // 详细视图：2根柱子（snell/vless），每根柱子堆叠上传下载。
      // 颜色首先编码方向（上行紫 / 下行青），协议靠透明度区分——方向语义全站一致，
      // 不能像以前那样按协议分蓝紫两族，否则「蓝色是上传还是 snell」永远说不清。
      const upDim = hexToRgba(pal.up, 0.55);
      const downDim = hexToRgba(pal.down, 0.55);
      datasets = [
        {
          label: "snell 下载",
          data: trendMonthlyData.map((d) => d.snell_rx / 1024 / 1024 / 1024),
          backgroundColor: pal.down,
          borderRadius: { bottomLeft: 4, bottomRight: 4 },
          stack: "snell",
        },
        {
          label: "snell 上传",
          data: trendMonthlyData.map((d) => d.snell_tx / 1024 / 1024 / 1024),
          backgroundColor: pal.up,
          borderRadius: { topLeft: 4, topRight: 4 },
          stack: "snell",
        },
        {
          label: "vless 下载",
          data: trendMonthlyData.map((d) => d.vless_rx / 1024 / 1024 / 1024),
          backgroundColor: downDim,
          borderRadius: { bottomLeft: 4, bottomRight: 4 },
          stack: "vless",
        },
        {
          label: "vless 上传",
          data: trendMonthlyData.map((d) => d.vless_tx / 1024 / 1024 / 1024),
          backgroundColor: upDim,
          borderRadius: { topLeft: 4, topRight: 4 },
          stack: "vless",
        },
      ];
      legendHtml = `
        <span class="legend-item"><span class="dot" style="background:${pal.up}"></span>snell 上传</span>
        <span class="legend-item"><span class="dot" style="background:${pal.down}"></span>snell 下载</span>
        <span class="legend-item"><span class="dot" style="background:${upDim}"></span>vless 上传</span>
        <span class="legend-item"><span class="dot" style="background:${downDim}"></span>vless 下载</span>
      `;
    } else {
      // 总计视图：2根柱子（上传/下载）
      datasets = [
        {
          label: "上传",
          data: trendMonthlyData.map((d) => d.total_tx / 1024 / 1024 / 1024),
          backgroundColor: pal.up,
          borderRadius: 4,
        },
        {
          label: "下载",
          data: trendMonthlyData.map((d) => d.total_rx / 1024 / 1024 / 1024),
          backgroundColor: pal.down,
          borderRadius: 4,
        },
      ];
      legendHtml = `
        <span class="legend-item"><span class="dot" style="background:${pal.up}"></span>上传</span>
        <span class="legend-item"><span class="dot" style="background:${pal.down}"></span>下载</span>
      `;
    }

    tickCallback = function (value, index) {
      return [totalLabels[index], "", labels[index]];
    };
  } else {
    const source = trendRange === "cycle" ? trendCycleData : trendDailyData;
    if (!source) return;

    updateTrendToggleState();

    // 完整日期标签（用于 tooltip）
    labels = source.map((d) => d.date.slice(5));
    const totals = source.map((d) => (d.tx + d.rx) / 1024 / 1024 / 1024);
    const txData = source.map((d) => d.tx / 1024 / 1024 / 1024);
    const rxData = source.map((d) => d.rx / 1024 / 1024 / 1024);

    // 全新安装时接口返回空数组：不兜住的话 0/0 会让均值成 NaN、
    // Math.max() 成 -Infinity，指标条与均值/峰值注解一起变成 NaN
    const hasData = totals.length > 0;

    // 计算平均值用于参考线
    const avgValue = hasData
      ? totals.reduce((a, b) => a + b, 0) / totals.length
      : 0;

    // 汇总总量
    const sumTotal = totals.reduce((a, b) => a + b, 0);
    const sumTx = txData.reduce((a, b) => a + b, 0);
    const sumRx = rxData.reduce((a, b) => a + b, 0);

    // 计算 Y 轴动态范围
    const maxValue = hasData ? Math.max(...totals, avgValue) : 0;
    const yMax = niceCeil(maxValue * 1.15); // 留出 15% 空间

    // 生成渐变填充（34% → 2%）
    const makeTrendGradient = (context) => {
      const chart = context.chart;
      const { chartArea } = chart;
      if (!chartArea) return hexToRgba(pal.down, 0.2);
      const gradient = chart.ctx.createLinearGradient(
        0,
        chartArea.top,
        0,
        chartArea.bottom,
      );
      gradient.addColorStop(0, hexToRgba(pal.down, 0.34));
      gradient.addColorStop(1, hexToRgba(pal.down, 0.02));
      return gradient;
    };

    // 今日数据点特殊样式（最后一个点）+ hover 时高亮
    const pointRadii = totals.map((_, i) => (i === totals.length - 1 ? 6 : 0));
    const pointHoverRadii = totals.map(() => 6); // 悬停时所有点都高亮
    const pointBgColors = totals.map((_, i) =>
      i === totals.length - 1 ? pal.down : "transparent",
    );
    const pointHoverBgColors = totals.map(() => pal.down);
    const pointBorderColors = totals.map((_, i) =>
      i === totals.length - 1 ? "#fff" : "transparent",
    );
    const pointHoverBorderColors = totals.map(() => "#fff");
    const pointBorderWidths = totals.map((_, i) =>
      i === totals.length - 1 ? 2 : 0,
    );

    // 计算极值索引
    const maxIdx = hasData ? totals.indexOf(Math.max(...totals)) : -1;
    const maxVal = hasData ? totals[maxIdx] : 0;

    datasets = [
      {
        label: "总流量",
        data: totals,
        borderColor: pal.down,
        backgroundColor: makeTrendGradient,
        borderWidth: 2.5,
        pointRadius: pointRadii,
        pointHoverRadius: pointHoverRadii,
        pointBackgroundColor: pointBgColors,
        pointHoverBackgroundColor: pointHoverBgColors,
        pointBorderColor: pointBorderColors,
        pointHoverBorderColor: pointHoverBorderColors,
        pointBorderWidth: pointBorderWidths,
        tension: 0.4,
        cubicInterpolationMode: "monotone",
        fill: true,
      },
      {
        label: "上传",
        data: txData,
        borderColor: hexToRgba(pal.up, 0.75),
        backgroundColor: "transparent",
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: pal.up,
        tension: 0.4,
        cubicInterpolationMode: "monotone",
        fill: false,
      },
      {
        label: "下载",
        data: rxData,
        borderColor: hexToRgba(pal.down, 0.55),
        backgroundColor: "transparent",
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: pal.down,
        tension: 0.4,
        cubicInterpolationMode: "monotone",
        fill: false,
      },
    ];

    // 这些数字全部搬进了卡片顶部的指标条，底部图例留空（CSS 的 :empty 会收掉间距）
    renderTrendMetrics({
      sum: sumTotal,
      tx: sumTx,
      rx: sumRx,
      avg: avgValue,
      avgLabel: "日均",
      peak: maxVal,
      peakLabel: hasData ? `峰值 ${labels[maxIdx]}` : "峰值",
      today: hasData ? totals[totals.length - 1] : 0,
    });
    legendHtml = "";
    chartType = "line";

    // X 轴稀疏显示（每 5 天）
    tickCallback = function (value, index) {
      // 显示首尾 + 每隔5天
      if (index === 0 || index === labels.length - 1 || index % 5 === 0) {
        return labels[index];
      }
      return "";
    };

    // 星期名称映射
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

    // Tooltip 回调 - 每条线显示自己的数据
    tooltipCallbacks = {
      title: (items) => {
        const idx = items[0]?.dataIndex;
        if (idx === undefined) return "";
        const d = source[idx];
        if (!d) return "";
        const dateObj = new Date(d.date);
        const weekday = weekdays[dateObj.getDay()];
        return `${d.date} (${weekday})`;
      },
      label: (ctx) => {
        const val = ctx.raw;
        const fmt =
          val >= 1 ? `${val.toFixed(2)} GB` : `${(val * 1024).toFixed(0)} MB`;
        return ` ${ctx.dataset.label}: ${fmt}`;
      },
      afterLabel: (ctx) => {
        // 仅总流量行显示较均值对比
        if (ctx.dataset.label !== "总流量") return "";
        if (avgValue <= 0) return "";
        const diff = ((ctx.raw - avgValue) / avgValue) * 100;
        if (Math.abs(diff) < 1) return "  ≈ 均值";
        const sign = diff > 0 ? "+" : "";
        const arrow = diff > 0 ? "↑" : "↓";
        return `  ${arrow} 较均值 ${sign}${diff.toFixed(0)}%`;
      },
      labelColor: (ctx) => {
        const colors = { 总流量: pal.down, 上传: pal.up, 下载: pal.down };
        const c = colors[ctx.dataset.label] || pal.muted;
        return { borderColor: c, backgroundColor: c };
      },
    };

    // 空数据下这三个注解全部跳过：0 位置上的均值线与红色峰值环
    // 会被读成「均值/峰值就是 0」，比什么都不画更容易误导
    if (hasData) {
      // 平均参考线注解 + Avg 标签
      trendAvgAnnotation = {
        type: "line",
        yMin: avgValue,
        yMax: avgValue,
        borderColor: hexToRgba(pal.muted, 0.55),
        borderWidth: 1.5,
        borderDash: [6, 4],
        label: {
          display: true,
          // 胶囊贴在均值线左端，垂直位置由 annotation 按 yMin/yMax 换算，无需自己算比例
          content: `Avg ${avgValue.toFixed(1)}`,
          position: "start",
          backgroundColor: hexToRgba(pal.muted, 0.75),
          color: "#fff",
          font: { size: 10, weight: "500" },
          padding: { top: 2, bottom: 2, left: 4, right: 4 },
          borderRadius: 4,
        },
      };

      // 峰值圆环
      trendMaxAnnotation = {
        type: "point",
        xValue: maxIdx,
        yValue: maxVal,
        backgroundColor: hexToRgba(pal.danger, 0.15),
        borderColor: pal.danger,
        borderWidth: 2,
        radius: 8,
      };

      // 峰值文字必须是独立的 label 注解：annotation 插件 v3 起 point 注解不再支持
      // 内嵌 label（line 注解的 label 仍然有效，均值线那条就是），写在 point 里不报错也不画
      trendMaxLabelAnnotation = {
        type: "label",
        xValue: maxIdx,
        yValue: maxVal,
        yAdjust: -24,
        content: `峰值 ${maxVal.toFixed(1)} GB`,
        backgroundColor: hexToRgba(pal.danger, 0.85),
        color: "#fff",
        font: { size: 10, weight: "600" },
        padding: { top: 3, bottom: 3, left: 6, right: 6 },
        borderRadius: 6,
      };
    }

    trendYMax = yMax;
  }

  // 更新图例
  setHtml("trend-legend", legendHtml);

  // 根据图表类型配置不同的选项
  const isLineChart = chartType === "line";
  const tickColor = pal.axis;
  const tip = tooltipColors();

  // 构建 annotations 配置
  const annotationsConfig = {};
  if (trendAvgAnnotation) annotationsConfig.avgLine = trendAvgAnnotation;
  if (trendMaxAnnotation) annotationsConfig.maxPoint = trendMaxAnnotation;
  if (trendMaxLabelAnnotation) {
    annotationsConfig.maxLabel = trendMaxLabelAnnotation;
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    layout: {
      padding: { left: 0, right: 0 },
    },
    interaction: {
      mode: "index",
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        mode: "index",
        intersect: false,
        callbacks: tooltipCallbacks,
        backgroundColor: tip.bg,
        titleColor: tip.text,
        bodyColor: tip.text,
        footerColor: tip.footer,
        borderColor: tip.border,
        borderWidth: 1,
        cornerRadius: 8,
        padding: 12,
        displayColors: true,
        usePointStyle: true,
        boxPadding: 4,
        titleFont: { weight: "600" },
      },
      annotation:
        Object.keys(annotationsConfig).length > 0
          ? { annotations: annotationsConfig }
          : undefined,
    },
    scales: {
      x: {
        offset: !isLineChart, // 柱状图保留 offset，折线图撑满
        grid: { display: false },
        ticks: {
          color: tickColor,
          font: { size: 10 },
          callback: tickCallback || undefined,
          maxRotation: 0,
          autoSkip: false,
        },
      },
      y: isLineChart
        ? {
            display: true,
            position: "left",
            beginAtZero: true,
            max: trendYMax || undefined,
            // 46px 是设计稿的轴宽，但只当下限用：硬钉死会把 "100 GB" 这类
            // 满格刻度裁掉左半边（量纲由数据定，写死宽度迟早撞上）。
            // 取 max 后短刻度仍按 46px 对齐，长刻度自己撑开
            afterFit: (scale) => {
              scale.width = Math.max(46, scale.width);
            },
            grid: {
              color: pal.divider,
              drawBorder: false,
            },
            ticks: {
              color: tickColor,
              font: { size: 10 },
              padding: 8,
              maxTicksLimit: 5,
              // 只有顶端那格带单位：整条轴共用一个量纲，每格都写 "GB" 既冗余，
              // 也会让 "100.0 GB" 超出钉死的 46px 而被裁掉左半边
              callback: (value) => formatTrendAxis(value, trendYMax),
            },
            border: { display: false },
          }
        : {
            display: false,
            beginAtZero: true,
          },
    },
  };

  const canvas = /** @type {HTMLCanvasElement} */ ($("trend-chart"));
  const ctx = canvas.getContext("2d");
  if (trendChart && trendChartType !== chartType) {
    trendChart.destroy();
    trendChart = null;
  }
  trendChartType = chartType;

  // 自定义 Crosshair 插件（仅对折线图生效）
  const crosshairPlugin = {
    id: "trendCrosshair",
    afterDraw: (chart) => {
      if (chart.tooltip?._active?.length && chartType === "line") {
        const activePoint = chart.tooltip._active[0];
        const { ctx: chartCtx } = chart;
        const { top, bottom } = chart.chartArea;
        const x = activePoint.element.x;

        chartCtx.save();
        chartCtx.beginPath();
        chartCtx.moveTo(x, top);
        chartCtx.lineTo(x, bottom);
        chartCtx.lineWidth = 1;
        // 现取而非用闭包捕获的值：插件只在 new Chart 那一支传入，走 update 分支时
        // 闭包里还是首次建图时的主题，切主题后准星颜色不会跟着变
        chartCtx.strokeStyle = isLight()
          ? "rgba(0, 0, 0, 0.15)"
          : "rgba(255, 255, 255, 0.25)";
        chartCtx.setLineDash([4, 4]);
        chartCtx.stroke();
        chartCtx.restore();
      }
    },
  };

  if (trendChart) {
    trendChart.data.labels = labels;
    trendChart.data.datasets = datasets;
    trendChart.options = options;
    trendChart.update("none");
  } else {
    trendChart = new Chart(ctx, {
      type: chartType,
      data: { labels, datasets },
      options,
      plugins: [crosshairPlugin],
    });
  }
}

// 视图切换
function setupTrendToggle() {
  on("trend-detail", "click", () => setView("detail"));
  on("trend-total", "click", () => setView("total"));
  on("trend-range-month", "click", () => setRange("monthly"));
  on("trend-range-30d", "click", () => setRange("30d"));
  on("trend-range-cycle", "click", () => setRange("cycle"));

  updateTrendToggleState();
}

/** @param {"total"|"detail"} view */
function setView(view) {
  trendView = view;
  updateTrendToggleState();
  // 总计/详细只影响月度柱状图的堆叠方式，日视图下切了也没东西要重画
  if (trendRange === "monthly") renderTrendChart();
}

/** @param {"monthly"|"30d"|"cycle"} range */
function setRange(range) {
  trendRange = range;
  updateTrendToggleState();

  if (range === "monthly") {
    renderTrendChart();
    return;
  }

  // 已经拉过的区间直接重画，别为了切个 tab 再打一次接口
  const cached = range === "cycle" ? trendCycleData : trendDailyData;
  if (cached) {
    renderTrendChart();
    return;
  }
  fetchDailyTrend(range);
}
