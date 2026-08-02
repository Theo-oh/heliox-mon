// 历史趋势：近 6 个月柱状图 / 近 30 天与计费周期折线图

import { $, setHtml, setText } from "../core/dom.js";
import { niceCeil } from "../core/format.js";
import { getJSON, logFetchError } from "../core/http.js";
import { isLight, onThemeChange } from "../core/theme.js";
import { Chart } from "../core/vendor.js";

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

function setTrendTitle(text) {
  setText("trend-title", text);
}

function setToggleState(el, active) {
  if (!el) return;
  if (active) {
    el.classList.add("active");
    el.classList.remove("btn-secondary");
  } else {
    el.classList.remove("active");
    el.classList.add("btn-secondary");
  }
}

function updateTrendToggleState() {
  setToggleState($("trend-range-month"), trendRange === "monthly");
  setToggleState($("trend-range-30d"), trendRange === "30d");
  setToggleState($("trend-range-cycle"), trendRange === "cycle");
  setToggleState($("trend-total"), trendView === "total");
  setToggleState($("trend-detail"), trendView === "detail");

  const viewToggle = $("trend-view-toggle");
  if (viewToggle) {
    viewToggle.style.display =
      trendRange === "monthly" ? "inline-flex" : "none";
  }
}

async function fetchDailyTrend(rangeType) {
  const range = rangeType === "cycle" ? "cycle" : "30d";
  try {
    const data = await getJSON(`/api/traffic/daily?range=${range}`);

    if (!data || !Array.isArray(data)) {
      console.warn("每日趋势数据为空");
      return;
    }

    const sorted = data.slice().sort((a, b) => a.date.localeCompare(b.date));

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
  let trendYMax = null;

  if (trendRange === "monthly") {
    if (!trendMonthlyData) return;

    setTrendTitle("近6个月流量");
    updateTrendToggleState();

    labels = trendMonthlyData.map((d) => {
      const parts = d.month.split("-");
      return parts[1] + "月";
    });
    const totalLabels = trendMonthlyData.map((d) => d.total_gb);

    if (trendView === "detail") {
      // 详细视图：2根柱子（snell/vless），每根柱子堆叠上传下载
      datasets = [
        {
          label: "snell 下载",
          data: trendMonthlyData.map((d) => d.snell_rx / 1024 / 1024 / 1024),
          backgroundColor: "#4DD4FF", // Neon cyan
          borderRadius: { bottomLeft: 4, bottomRight: 4 },
          stack: "snell",
        },
        {
          label: "snell 上传",
          data: trendMonthlyData.map((d) => d.snell_tx / 1024 / 1024 / 1024),
          backgroundColor: "#3B82F6", // Electric blue
          borderRadius: { topLeft: 4, topRight: 4 },
          stack: "snell",
        },
        {
          label: "vless 下载",
          data: trendMonthlyData.map((d) => d.vless_rx / 1024 / 1024 / 1024),
          backgroundColor: "#9B8CFF", // Neon lavender
          borderRadius: { bottomLeft: 4, bottomRight: 4 },
          stack: "vless",
        },
        {
          label: "vless 上传",
          data: trendMonthlyData.map((d) => d.vless_tx / 1024 / 1024 / 1024),
          backgroundColor: "#6D28D9", // Deep violet
          borderRadius: { topLeft: 4, topRight: 4 },
          stack: "vless",
        },
      ];
      legendHtml = `
        <span class="legend-item"><span class="dot" style="background:#3B82F6"></span>snell 上传</span>
        <span class="legend-item"><span class="dot" style="background:#4DD4FF"></span>snell 下载</span>
        <span class="legend-item"><span class="dot" style="background:#6D28D9"></span>vless 上传</span>
        <span class="legend-item"><span class="dot" style="background:#9B8CFF"></span>vless 下载</span>
      `;
    } else {
      // 总计视图：2根柱子（上传/下载）
      datasets = [
        {
          label: "上传",
          data: trendMonthlyData.map((d) => d.total_tx / 1024 / 1024 / 1024),
          backgroundColor: "#4F7DF7", // Cobalt blue
          borderRadius: 4,
        },
        {
          label: "下载",
          data: trendMonthlyData.map((d) => d.total_rx / 1024 / 1024 / 1024),
          backgroundColor: "#39D0C3", // Tech teal
          borderRadius: 4,
        },
      ];
      legendHtml = `
        <span class="legend-item"><span class="dot" style="background:#4F7DF7"></span>上传</span>
        <span class="legend-item"><span class="dot" style="background:#39D0C3"></span>下载</span>
      `;
    }

    tickCallback = function (value, index) {
      return [totalLabels[index], "", labels[index]];
    };
  } else {
    const source = trendRange === "cycle" ? trendCycleData : trendDailyData;
    if (!source) return;

    setTrendTitle(trendRange === "cycle" ? "本计费周期流量" : "近30天流量");
    updateTrendToggleState();

    // 完整日期标签（用于 tooltip）
    labels = source.map((d) => d.date.slice(5));
    const totals = source.map((d) => (d.tx + d.rx) / 1024 / 1024 / 1024);
    const txData = source.map((d) => d.tx / 1024 / 1024 / 1024);
    const rxData = source.map((d) => d.rx / 1024 / 1024 / 1024);

    // 计算平均值用于参考线
    const avgValue = totals.reduce((a, b) => a + b, 0) / totals.length;

    // 汇总总量
    const sumTotal = totals.reduce((a, b) => a + b, 0);
    const sumTx = txData.reduce((a, b) => a + b, 0);
    const sumRx = rxData.reduce((a, b) => a + b, 0);

    // 计算 Y 轴动态范围
    const maxValue = Math.max(...totals, avgValue);
    const yMax = niceCeil(maxValue * 1.15); // 留出 15% 空间

    // 生成渐变填充（40% → 5%）
    const makeTrendGradient = (context) => {
      const chart = context.chart;
      const { chartArea } = chart;
      if (!chartArea) return "rgba(10, 132, 255, 0.2)";
      const gradient = chart.ctx.createLinearGradient(
        0,
        chartArea.top,
        0,
        chartArea.bottom,
      );
      gradient.addColorStop(0, "rgba(10, 132, 255, 0.40)");
      gradient.addColorStop(1, "rgba(10, 132, 255, 0.05)");
      return gradient;
    };

    // 今日数据点特殊样式（最后一个点）+ hover 时高亮
    const pointRadii = totals.map((_, i) => (i === totals.length - 1 ? 6 : 0));
    const pointHoverRadii = totals.map(() => 6); // 悬停时所有点都高亮
    const pointBgColors = totals.map((_, i) =>
      i === totals.length - 1 ? "#007AFF" : "transparent",
    );
    const pointHoverBgColors = totals.map(() => "#007AFF"); // 悬停时蓝色
    const pointBorderColors = totals.map((_, i) =>
      i === totals.length - 1 ? "#fff" : "transparent",
    );
    const pointHoverBorderColors = totals.map(() => "#fff");
    const pointBorderWidths = totals.map((_, i) =>
      i === totals.length - 1 ? 2 : 0,
    );

    // 计算极值索引
    const maxIdx = totals.indexOf(Math.max(...totals));
    const maxVal = totals[maxIdx];

    datasets = [
      {
        label: "总流量",
        data: totals,
        borderColor: "#007AFF", // macOS System Blue
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
        borderColor: "rgba(79, 125, 247, 0.6)",
        backgroundColor: "transparent",
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: "#4F7DF7",
        tension: 0.4,
        cubicInterpolationMode: "monotone",
        fill: false,
      },
      {
        label: "下载",
        data: rxData,
        borderColor: "rgba(57, 208, 195, 0.6)",
        backgroundColor: "transparent",
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: "#39D0C3",
        tension: 0.4,
        cubicInterpolationMode: "monotone",
        fill: false,
      },
    ];

    // 格式化汇总值
    const fmtSum = (v) =>
      v >= 1 ? `${v.toFixed(1)} GB` : `${(v * 1024).toFixed(0)} MB`;

    // 今日流量数值（最后一个点）
    const todayValue = totals[totals.length - 1];
    const todayLabel =
      todayValue >= 1
        ? `${todayValue.toFixed(1)} GB`
        : `${(todayValue * 1024).toFixed(0)} MB`;

    legendHtml = `
      <span class="legend-item"><span class="dot" style="background:#007AFF"></span>总流量 ${fmtSum(sumTotal)}</span>
      <span class="legend-item"><span class="dot" style="background:#4F7DF7; opacity:0.6"></span>↑ ${fmtSum(sumTx)}</span>
      <span class="legend-item"><span class="dot" style="background:#39D0C3; opacity:0.6"></span>↓ ${fmtSum(sumRx)}</span>
      <span class="legend-item"><span class="dot" style="background:#86868b; opacity:0.6"></span>日均 ${avgValue.toFixed(2)} GB</span>
      <span class="legend-item trend-today-badge"><span class="trend-today-pulse"></span>今日 ${todayLabel}</span>
    `;
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
        const fmt = val >= 1 ? `${val.toFixed(2)} GB` : `${(val * 1024).toFixed(0)} MB`;
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
        const colors = { "总流量": "#007AFF", "上传": "#4F7DF7", "下载": "#39D0C3" };
        const c = colors[ctx.dataset.label] || "#888";
        return { borderColor: c, backgroundColor: c };
      },
    };

    // 平均参考线注解 + Avg 标签
    trendAvgAnnotation = {
      type: "line",
      yMin: avgValue,
      yMax: avgValue,
      borderColor: "rgba(134, 134, 139, 0.5)",
      borderWidth: 1.5,
      borderDash: [6, 4],
      label: {
        display: true,
        content: "Avg",
        position: "start",
        backgroundColor: "rgba(134, 134, 139, 0.7)",
        color: "#fff",
        font: { size: 10, weight: "500" },
        padding: { top: 2, bottom: 2, left: 4, right: 4 },
        borderRadius: 4,
      },
    };

    // Max 极值标注
    trendMaxAnnotation = {
      type: "point",
      xValue: maxIdx,
      yValue: maxVal,
      backgroundColor: "rgba(255, 69, 58, 0.15)",
      borderColor: "#FF453A",
      borderWidth: 2,
      radius: 8,
      label: {
        display: true,
        content: `Max ${maxVal.toFixed(1)}G`,
        position: "top",
        backgroundColor: "rgba(255, 69, 58, 0.85)",
        color: "#fff",
        font: { size: 10, weight: "600" },
        padding: { top: 3, bottom: 3, left: 6, right: 6 },
        borderRadius: 6,
        yAdjust: -12,
      },
    };

    trendYMax = yMax;
  }

  // 更新图例
  setHtml("trend-legend", legendHtml);

  // 根据图表类型配置不同的选项
  const isLineChart = chartType === "line";
  const light = isLight();
  const gridColor = light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)"; // 10% 透明度
  const tickColor = "#8E8E93"; // System Gray 2

  // 构建 annotations 配置
  const annotationsConfig = {};
  if (trendAvgAnnotation) annotationsConfig.avgLine = trendAvgAnnotation;
  if (trendMaxAnnotation) annotationsConfig.maxPoint = trendMaxAnnotation;

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
        backgroundColor: light
          ? "rgba(255, 255, 255, 0.95)"
          : "rgba(28, 28, 30, 0.95)",
        titleColor: light ? "#1c1c1e" : "#f5f5f7",
        bodyColor: light ? "#1c1c1e" : "#f5f5f7",
        footerColor: light ? "#86868b" : "#8E8E93",
        borderColor: light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
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
            grid: {
              color: gridColor,
              drawBorder: false,
              borderDash: [4, 4],
            },
            ticks: {
              color: tickColor,
              padding: 8,
              callback: (value) => {
                if (value >= 1024) return `${(value / 1024).toFixed(1)} TB`;
                if (value >= 1) return `${value.toFixed(1)} GB`;
                return `${(value * 1024).toFixed(0)} MB`;
              },
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
        chartCtx.strokeStyle = light
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
  const detailBtn = $("trend-detail");
  const totalBtn = $("trend-total");
  const rangeMonthBtn = $("trend-range-month");
  const range30Btn = $("trend-range-30d");
  const rangeCycleBtn = $("trend-range-cycle");

  if (detailBtn) {
    detailBtn.addEventListener("click", () => {
      trendView = "detail";
      updateTrendToggleState();
      if (trendRange === "monthly") {
        renderTrendChart();
      }
    });
  }

  if (totalBtn) {
    totalBtn.addEventListener("click", () => {
      trendView = "total";
      updateTrendToggleState();
      if (trendRange === "monthly") {
        renderTrendChart();
      }
    });
  }

  if (rangeMonthBtn) {
    rangeMonthBtn.addEventListener("click", () => {
      trendRange = "monthly";
      updateTrendToggleState();
      renderTrendChart();
    });
  }

  if (range30Btn) {
    range30Btn.addEventListener("click", () => {
      trendRange = "30d";
      updateTrendToggleState();
      if (trendDailyData) {
        renderTrendChart();
        return;
      }
      fetchDailyTrend("30d");
    });
  }

  if (rangeCycleBtn) {
    rangeCycleBtn.addEventListener("click", () => {
      trendRange = "cycle";
      updateTrendToggleState();
      if (trendCycleData) {
        renderTrendChart();
        return;
      }
      fetchDailyTrend("cycle");
    });
  }

  updateTrendToggleState();
}
