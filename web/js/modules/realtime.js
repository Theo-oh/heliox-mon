// 实时网速：SSE 每秒推一个点，60 点滑动窗口

import { $, setText } from "../core/dom.js";
import {
  formatAxisSpeed,
  formatSpeed,
  formatSpeedParts,
  formatTimeLabel,
  getSpeedScale,
} from "../core/format.js";
import { onStreamEvent } from "../core/stream.js";
import { getCssVar, hexToRgba, isLight, onThemeChange } from "../core/theme.js";
import { Chart } from "../core/vendor.js";

const realtimeWindowSize = 60;

/** @type {any} */
let realtimeChart = null;
let realtimeScale = getSpeedScale(1024);

// 窗口未填满前用 null 占位而非 0，避免图表和 tooltip 把"还没数据"显示成"速度为 0"。
// ⚠️ 这三个数组的引用被 Chart.js 的 dataset 持有，只能原地 shift/push；
//    任何整体赋值都会让图表静止而读数继续跳动——不报错，极难查。
const realtimeLabels = Array.from({ length: realtimeWindowSize }, () => "");
const realtimeTxSeries = Array.from({ length: realtimeWindowSize }, () => null);
const realtimeRxSeries = Array.from({ length: realtimeWindowSize }, () => null);

export function initRealtime() {
  initRealtimeChart();
  onThemeChange(applyRealtimeTheme);
  onStreamEvent("message", onSpeedFrame);
}

function onSpeedFrame(data) {
  const txSpeed = Math.max(0, Number(data.tx_speed) || 0);
  const rxSpeed = Math.max(0, Number(data.rx_speed) || 0);
  setText("tx-speed", formatSpeed(txSpeed));
  setText("rx-speed", formatSpeed(rxSpeed));
  pushRealtimePoint(txSpeed, rxSpeed);
}

function getRealtimePalette() {
  const light = isLight();
  return {
    down: getCssVar("--speed-down") || "#4dd4ff",
    up: getCssVar("--speed-up") || "#b66cff",
    grid: getCssVar("--speed-grid") || "rgba(255, 255, 255, 0.08)",
    muted: getCssVar("--muted") || "#6e6e80",
    text: getCssVar("--text") || "#f5f5f7",
    tooltipBg: light ? "rgba(255, 255, 255, 0.95)" : "rgba(28, 28, 30, 0.95)",
    tooltipText: light ? "#1c1c1e" : "#f5f5f7",
    tooltipBorder: light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
  };
}

function buildRealtimeTooltip(palette) {
  return {
    enabled: true,
    backgroundColor: palette.tooltipBg,
    titleColor: palette.tooltipText,
    bodyColor: palette.tooltipText,
    borderColor: palette.tooltipBorder,
    borderWidth: 1,
    cornerRadius: 8,
    padding: 12,
    displayColors: true,
    usePointStyle: true,
    boxPadding: 4,
    titleFont: { weight: "600" },
    callbacks: {
      title: (items) => items[0]?.label || "",
      label: (item) =>
        ` ${item.dataset.label} ${formatSpeed(item.parsed.y ?? 0)}`,
    },
  };
}

function makeSpeedFill(color) {
  return (context) => {
    const chart = context.chart;
    const { chartArea } = chart;
    if (!chartArea) return hexToRgba(color, 0.2);
    const gradient = chart.ctx.createLinearGradient(
      0,
      chartArea.top,
      0,
      chartArea.bottom,
    );
    gradient.addColorStop(0, hexToRgba(color, 0.28));
    gradient.addColorStop(1, hexToRgba(color, 0.02));
    return gradient;
  };
}

function buildRealtimeDatasets(palette) {
  return [
    {
      label: "上传",
      data: realtimeTxSeries,
      borderColor: palette.up,
      backgroundColor: makeSpeedFill(palette.up),
      borderWidth: 2,
      borderJoinStyle: "round",
      borderCapStyle: "round",
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0,
      fill: true,
    },
    {
      label: "下载",
      data: realtimeRxSeries,
      borderColor: palette.down,
      backgroundColor: makeSpeedFill(palette.down),
      borderWidth: 2,
      borderJoinStyle: "round",
      borderCapStyle: "round",
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0,
      fill: true,
    },
  ];
}

function applyRealtimeTicks(scale) {
  const maxVal = realtimeScale.maxBytes || scale.max || 1;
  const ticks = [0, maxVal / 2, maxVal].map((value) => ({
    value: Math.round(value),
  }));
  scale.ticks = ticks;
}

function initRealtimeChart() {
  const canvas = $("realtime-chart");
  if (!canvas) return;
  const palette = getRealtimePalette();
  const ctx = /** @type {HTMLCanvasElement} */ (canvas).getContext("2d");

  realtimeChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: realtimeLabels,
      datasets: buildRealtimeDatasets(palette),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: 12 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          align: "center",
          labels: {
            color: palette.muted,
            usePointStyle: true,
            pointStyle: "line",
            boxWidth: 28,
          },
        },
        tooltip: buildRealtimeTooltip(palette),
      },
      scales: {
        x: {
          display: false,
          grid: { display: false },
          ticks: { display: false },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          min: 0,
          max: realtimeScale.maxBytes,
          position: "right",
          grace: "5%",
          grid: { color: palette.grid },
          ticks: {
            color: palette.muted,
            padding: 12,
            callback: (value) => formatAxisSpeed(value),
          },
          afterBuildTicks: applyRealtimeTicks,
          title: {
            display: false,
          },
          border: { display: false },
        },
      },
    },
  });
}

function applyRealtimeTheme() {
  if (!realtimeChart) return;
  const palette = getRealtimePalette();
  const datasets = realtimeChart.data.datasets;
  if (datasets[0]) {
    datasets[0].borderColor = palette.up;
    datasets[0].backgroundColor = makeSpeedFill(palette.up);
  }
  if (datasets[1]) {
    datasets[1].borderColor = palette.down;
    datasets[1].backgroundColor = makeSpeedFill(palette.down);
  }
  realtimeChart.options.scales.x.ticks.color = palette.muted;
  realtimeChart.options.scales.y.ticks.color = palette.muted;
  realtimeChart.options.scales.y.grid.color = palette.grid;
  if (realtimeChart.options.plugins?.legend?.labels) {
    realtimeChart.options.plugins.legend.labels.color = palette.muted;
  }
  realtimeChart.options.plugins.tooltip = buildRealtimeTooltip(palette);
  realtimeChart.update("none");
}

function updateRealtimeScale() {
  let maxVal = 0;
  for (const v of realtimeTxSeries) {
    if (v > maxVal) maxVal = v;
  }
  for (const v of realtimeRxSeries) {
    if (v > maxVal) maxVal = v;
  }
  realtimeScale = getSpeedScale(maxVal);
  if (!realtimeChart) return;
  realtimeChart.options.scales.y.ticks.callback = (value) =>
    formatAxisSpeed(value);
  realtimeChart.options.scales.y.max = realtimeScale.maxBytes;
  realtimeChart.options.scales.y.title.text = realtimeScale.unit;
}

function updateRealtimeAverage() {
  const txEl = $("avg-tx");
  const rxEl = $("avg-rx");
  if (!txEl && !rxEl) return;

  let txSum = 0,
    rxSum = 0,
    count = 0;
  for (let i = 0; i < realtimeTxSeries.length; i++) {
    if (realtimeTxSeries[i] === null) continue; // 只对已采到的点求平均，否则开头一分钟会被占位值拉低
    txSum += realtimeTxSeries[i];
    rxSum += realtimeRxSeries[i];
    count++;
  }
  const txAvg = count ? txSum / count : 0;
  const rxAvg = count ? rxSum / count : 0;

  const [txNum, txUnit] = formatSpeedParts(txAvg);
  const [rxNum, rxUnit] = formatSpeedParts(rxAvg);
  if (txEl)
    txEl.innerHTML = `<span>↑</span><span>${txNum}</span><span>${txUnit}</span>`;
  if (rxEl)
    rxEl.innerHTML = `<span>↓</span><span>${rxNum}</span><span>${rxUnit}</span>`;
}

function pushRealtimePoint(txSpeed, rxSpeed) {
  const label = formatTimeLabel(new Date());
  realtimeLabels.shift();
  realtimeTxSeries.shift();
  realtimeRxSeries.shift();
  realtimeLabels.push(label);
  realtimeTxSeries.push(txSpeed);
  realtimeRxSeries.push(rxSpeed);

  updateRealtimeAverage();
  updateRealtimeScale();

  if (realtimeChart) {
    // Chart.js 把 hover 态记在 element 对象自己身上，而 shift() 每秒让整排 element 左移一格。
    // 鼠标不动时它只按 index 判断"激活的还是同一格"，于是既不清旧的、又给挪到这一格的新
    // element 补上高亮，每秒攒出一个跟着数据往左漂的圆点。这里在更新前把上一秒那个 element
    // 的 hover 样式摘掉，剩下的交给它自己重放鼠标位置，高亮就始终只落在光标压着的那一格。
    for (const el of realtimeChart.getActiveElements()) {
      realtimeChart
        .getDatasetMeta(el.datasetIndex)
        .controller.removeHoverStyle(el.element, el.datasetIndex, el.index);
    }
    realtimeChart.update("none"); // 每秒刷新，跳过动画路径
  }
}
