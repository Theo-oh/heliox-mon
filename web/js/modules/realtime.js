// 实时网速：SSE 每秒推一个点，60 点滑动窗口，镜像面积图（上行向上、下行向下）

import { $, setText } from "../core/dom.js";
import {
  formatAxisSpeed,
  formatBytesParts,
  formatSpeed,
  formatSpeedParts,
  formatTimeLabel,
  getSpeedScale,
} from "../core/format.js";
import { onStreamEvent } from "../core/stream.js";
import {
  hexToRgba,
  onThemeChange,
  palette,
  tooltipColors,
} from "../core/theme.js";
import { Chart } from "../core/vendor.js";

const realtimeWindowSize = 60;
// 右侧轴区宽度写死，才能让 HTML 里那行时间刻度（.rt-timeline 的 padding-right）与绘图区右边界对齐
const realtimeAxisWidth = 62;

/** @type {any} */
let realtimeChart = null;
let realtimeScale = getSpeedScale(1024);

// 窗口未填满前用 null 占位而非 0，避免图表和 tooltip 把"还没数据"显示成"速度为 0"。
// ⚠️ 这几个数组的引用被 Chart.js 的 dataset 持有，只能原地 shift/push；
//    任何整体赋值都会让图表静止而读数继续跳动——不报错，极难查。
const realtimeLabels = Array.from({ length: realtimeWindowSize }, () => "");
const realtimeTxSeries = Array.from({ length: realtimeWindowSize }, () => null);
const realtimeRxSeries = Array.from({ length: realtimeWindowSize }, () => null);
// 镜像图专用的下行取负副本：负值只喂给 Chart.js，均值/峰值/累计/量程一律读真值
// realtimeRxSeries。把负数写进真值数组会让量程比较漏掉全部下行点，累计变成上行减下行。
const realtimeRxPlot = Array.from({ length: realtimeWindowSize }, () => null);

export function initRealtime() {
  initRealtimeChart();
  onThemeChange(applyRealtimeTheme);
  onStreamEvent("message", onSpeedFrame);
}

function onSpeedFrame(data) {
  const txSpeed = Math.max(0, Number(data.tx_speed) || 0);
  const rxSpeed = Math.max(0, Number(data.rx_speed) || 0);
  setSpeedParts("tx-speed", "tx-speed-unit", txSpeed);
  setSpeedParts("rx-speed", "rx-speed-unit", rxSpeed);
  setText("rt-sum", formatSpeed(txSpeed + rxSpeed));
  pushRealtimePoint(txSpeed, rxSpeed);
}

/** 写入「大字号数值 + 小字号单位」的一对元素 */
/** @param {string} valueId @param {string} unitId @param {number} bytesPerSec */
function setSpeedParts(valueId, unitId, bytesPerSec) {
  const [num, unit] = formatSpeedParts(bytesPerSec);
  setText(valueId, num);
  setText(unitId, unit);
}

function buildRealtimeTooltip() {
  const tip = tooltipColors();
  return {
    enabled: true,
    backgroundColor: tip.bg,
    titleColor: tip.text,
    bodyColor: tip.text,
    borderColor: tip.border,
    borderWidth: 1,
    cornerRadius: 8,
    padding: 12,
    displayColors: true,
    usePointStyle: true,
    boxPadding: 4,
    titleFont: { weight: "600" },
    callbacks: {
      title: (items) => items[0]?.label || "",
      // 下行在图上是负值，tooltip 要显示真实速率
      label: (item) =>
        ` ${item.dataset.label} ${formatSpeed(Math.abs(item.parsed.y ?? 0))}`,
    },
  };
}

/**
 * 渐变横跨整个绘图区（而非只覆盖数据所在的一半），上行由浓到淡向下、下行由淡到浓向下，
 * 两半在 0 轴处浓度相当，视觉上是一条对称的带子。
 * @param {string} color @param {"up"|"down"} dir
 */
function makeSpeedFill(color, dir) {
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
    const [top, bottom] = dir === "up" ? [0.4, 0.02] : [0.02, 0.4];
    gradient.addColorStop(0, hexToRgba(color, top));
    gradient.addColorStop(1, hexToRgba(color, bottom));
    return gradient;
  };
}

function buildRealtimeDatasets(pal) {
  return [
    {
      label: "上行",
      data: realtimeTxSeries,
      borderColor: pal.up,
      backgroundColor: makeSpeedFill(pal.up, "up"),
      borderWidth: 2,
      borderJoinStyle: "round",
      borderCapStyle: "round",
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0,
      fill: "origin",
    },
    {
      label: "下行",
      data: realtimeRxPlot,
      borderColor: pal.down,
      backgroundColor: makeSpeedFill(pal.down, "down"),
      borderWidth: 2,
      borderJoinStyle: "round",
      borderCapStyle: "round",
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0,
      fill: "origin",
    },
  ];
}

/** @param {any} chart @param {number} value @param {string} color @param {number[]} dash */
function drawGridLine(chart, value, color, dash) {
  const { ctx, chartArea, scales } = chart;
  if (!chartArea || !scales.y) return;
  // +0.5 让 1px 线落在像素中心，否则在整数坐标上会被摊成两行灰
  const py = Math.round(scales.y.getPixelForValue(value)) + 0.5;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(chartArea.left, py);
  ctx.lineTo(chartArea.right, py);
  ctx.stroke();
  ctx.restore();
}

// 0 轴实线 + 上下各一条虚线网格。Chart.js 的 grid.borderDash 是整条轴一套样式，
// 做不出「0 轴与半程线不同虚实」，索性自己画；颜色在回调里现取，主题切换自动跟随。
const mirrorGridPlugin = {
  id: "realtimeMirrorGrid",
  beforeDatasetsDraw(chart) {
    const max = chart.scales.y?.max || 0;
    const pal = palette();
    drawGridLine(chart, max, pal.divider, []);
    drawGridLine(chart, -max, pal.divider, []);
    drawGridLine(chart, max / 2, pal.grid, [3, 5]);
    drawGridLine(chart, -max / 2, pal.grid, [3, 5]);
  },
  // 0 轴画在数据之上：它是上下两半的分界，被面积填充盖住就失去了作用
  afterDatasetsDraw(chart) {
    drawGridLine(chart, 0, palette().gridAxis, []);
  },
};

// 只保留 -max / 0 / +max 三档刻度，半程线由 mirrorGridPlugin 画，不占标签位
function applyRealtimeTicks(scale) {
  const maxVal = realtimeScale.maxBytes || scale.max || 1;
  scale.ticks = [-maxVal, 0, maxVal].map((value) => ({
    value: Math.round(value),
  }));
}

function initRealtimeChart() {
  const canvas = $("realtime-chart");
  if (!canvas) return;
  const pal = palette();
  const ctx = /** @type {HTMLCanvasElement} */ (canvas).getContext("2d");

  realtimeChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: realtimeLabels,
      datasets: buildRealtimeDatasets(pal),
    },
    plugins: [mirrorGridPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false }, // 方向由图内左上/左下的角标说明
        tooltip: buildRealtimeTooltip(),
      },
      scales: {
        x: {
          display: false,
          grid: { display: false },
          ticks: { display: false },
          border: { display: false },
        },
        y: {
          min: -realtimeScale.maxBytes,
          max: realtimeScale.maxBytes,
          position: "right",
          grid: { display: false },
          border: { display: false },
          afterFit: (scale) => {
            scale.width = realtimeAxisWidth;
          },
          ticks: {
            padding: 6,
            // 0 用 muted 稍亮一档，作为上下两半的分界读数
            color: (item) =>
              item.tick.value === 0 ? palette().muted : palette().axis,
            callback: (value) =>
              value === 0 ? "0" : formatAxisSpeed(Math.abs(Number(value))),
          },
          afterBuildTicks: applyRealtimeTicks,
        },
      },
    },
  });
}

function applyRealtimeTheme() {
  if (!realtimeChart) return;
  const pal = palette();
  const datasets = realtimeChart.data.datasets;
  if (datasets[0]) {
    datasets[0].borderColor = pal.up;
    datasets[0].backgroundColor = makeSpeedFill(pal.up, "up");
  }
  if (datasets[1]) {
    datasets[1].borderColor = pal.down;
    datasets[1].backgroundColor = makeSpeedFill(pal.down, "down");
  }
  realtimeChart.options.plugins.tooltip = buildRealtimeTooltip();
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
  realtimeChart.options.scales.y.min = -realtimeScale.maxBytes;
  realtimeChart.options.scales.y.max = realtimeScale.maxBytes;
}

// 60s 均值 / 上下行峰值 / 窗口累计。峰值同时供读数行右侧的「峰值」使用。
function renderRealtimeMetrics() {
  let txSum = 0,
    rxSum = 0,
    txPeak = 0,
    rxPeak = 0,
    count = 0;
  for (let i = 0; i < realtimeTxSeries.length; i++) {
    const tx = realtimeTxSeries[i];
    if (tx === null) continue; // 只统计已采到的点，否则开头一分钟会被占位值拉低
    const rx = realtimeRxSeries[i];
    txSum += tx;
    rxSum += rx;
    if (tx > txPeak) txPeak = tx;
    if (rx > rxPeak) rxPeak = rx;
    count++;
  }

  setSpeedParts("avg-tx", "avg-tx-unit", count ? txSum / count : 0);
  setSpeedParts("avg-rx", "avg-rx-unit", count ? rxSum / count : 0);
  setSpeedParts("peak-tx", "peak-tx-unit", txPeak);
  setSpeedParts("peak-rx", "peak-rx-unit", rxPeak);
  setText("rt-peak", formatSpeed(Math.max(txPeak, rxPeak)));

  // 采样间隔恒为 1 秒，字节/秒逐点相加即窗口内的总字节数
  const [totalNum, totalUnit] = formatBytesParts(txSum + rxSum);
  setText("rt-window-total", totalNum);
  setText("rt-window-total-unit", totalUnit);
}

function pushRealtimePoint(txSpeed, rxSpeed) {
  const label = formatTimeLabel(new Date());
  realtimeLabels.shift();
  realtimeTxSeries.shift();
  realtimeRxSeries.shift();
  realtimeRxPlot.shift();
  realtimeLabels.push(label);
  realtimeTxSeries.push(txSpeed);
  realtimeRxSeries.push(rxSpeed);
  realtimeRxPlot.push(-rxSpeed);

  renderRealtimeMetrics();
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
