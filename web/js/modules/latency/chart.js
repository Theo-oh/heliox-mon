// 延迟图：ECharts 折线（左轴 ms）+ 丢包竖条（右轴 %）+ 无数据/异常区间色块。
// 只消费 index.js 传进来的模型，自己不算口径、不持有查询状态。

import { escapeHtml } from "../../core/dom.js";
import { niceCeil } from "../../core/format.js";
import { hexToRgba, isLight, palette, tooltipColors } from "../../core/theme.js";
import { echarts } from "../../core/vendor.js";
import { latencyPalette, targetColor } from "./palette.js";

/** @type {any} */
let chart = null;
let zoomBound = false;

/**
 * @param {any} model buildLatencyModel 的产物
 * @param {{showLoss: boolean, showMax: boolean, showAvg: boolean,
 *          zoom: {start: number, end: number},
 *          onZoom: (zoom: {start: number, end: number}) => void}} opts
 */
export function renderLatencyChart(model, opts) {
  const el = document.getElementById("latency-chart");
  if (!el || !echarts) return;

  if (!chart) {
    chart = echarts.init(el, null, { renderer: "canvas", useDirtyRect: true });
    // 监听只在建图那一次注册；放到 render 里每次都会再挂一个
    window.addEventListener("resize", () => chart?.resize());
  }

  // 颜色一律在这里现取：主题切换后 onThemeChange 会重新走到这一行
  const pal = palette();
  const tip = tooltipColors();
  const colors = latencyPalette();
  const light = isLight();
  const gridLine = light ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.05)";
  const labelBg = light ? "rgba(255, 255, 255, 0.92)" : "rgba(20, 20, 22, 0.9)";

  const yMax = latencyAxisMax(model.series);
  const series = buildSeries(model, opts, { pal, colors, light, labelBg });

  const option = {
    animation: false,
    // containLabel:false + 固定边距，才能和设计稿的 44/40px 轴区对上
    grid: {
      left: 46,
      right: opts.showLoss ? 44 : 16,
      top: 16,
      bottom: 26,
      containLabel: false,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: tip.bg,
      borderColor: tip.border,
      textStyle: { color: tip.text },
      axisPointer: { type: "cross", label: { color: tip.text } },
      formatter: (params) => tooltipHtml(params),
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: pal.border } },
      axisTick: { show: false },
      // 时间轴的默认 formatter 在日级刻度上只写一个「2」，看不出是几号还是几点；
      // 逐档写死后 24h 视图给 HH:mm、跨天视图给 MM-DD
      axisLabel: {
        color: pal.axis,
        fontSize: 10,
        hideOverlap: true,
        formatter: {
          year: "{yyyy}",
          month: "{MM}-{dd}",
          day: "{MM}-{dd}",
          hour: "{HH}:{mm}",
          minute: "{HH}:{mm}",
          second: "{HH}:{mm}",
          millisecond: "{HH}:{mm}",
        },
      },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value",
        min: 0,
        max: yMax,
        interval: yMax / 4,
        axisLine: { show: false },
        axisTick: { show: false },
        // 单位只挂在顶格刻度上（设计稿的「360 ms / 270 / 180…」）。轴 max 是自己
        // 算的，所以这里能确定地认出顶格，不必猜 ECharts 会分几段
        axisLabel: {
          color: pal.axis,
          fontSize: 10,
          margin: 8,
          formatter: (v) => (v >= yMax ? `${v} ms` : `${v}`),
        },
        splitLine: { lineStyle: { color: gridLine } },
      },
      {
        type: "value",
        show: opts.showLoss,
        min: 0,
        max: 100,
        interval: 25,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: pal.axis,
          fontSize: 10,
          margin: 8,
          formatter: (v) => (v >= 100 ? "{hot|100%}" : `${v}`),
          rich: { hot: { color: hexToRgba(pal.danger, 0.7), fontSize: 10 } },
        },
        splitLine: { show: false },
      },
    ],
    // 只留 inside：设计稿把滑块换成了图例行，滚轮/双指缩放仍然可用，
    // 统计口径跟着 onZoom 走
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        start: opts.zoom.start ?? 0,
        end: opts.zoom.end ?? 100,
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
        style: { text: "暂无数据", fill: pal.muted, fontSize: 14 },
      },
    ];
  }

  chart.setOption(option, true);
  bindZoom(opts.onZoom);
}

function buildSeries(model, opts, theme) {
  const { pal, colors, labelBg } = theme;
  const series = model.series.map((s, i) => {
    const color = targetColor(colors, s.idx);
    const avg = averageRtt(s.points);
    return {
      name: s.tag,
      type: "line",
      smooth: true,
      showSymbol: false,
      data: s.line,
      itemStyle: { color },
      lineStyle: { color, width: 1.4 },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: hexToRgba(color, 0.22) },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ]),
      },
      emphasis: { focus: "series" },
      markLine:
        opts.showAvg && avg > 0
          ? {
              symbol: "none",
              lineStyle: { type: "dashed", color, opacity: 0.65 },
              label: {
                color: pal.text,
                backgroundColor: hexToRgba(pal.muted, 0.5),
                borderRadius: 6,
                padding: [3, 6],
                fontSize: 10,
                position: "insideEndTop",
                formatter: ({ value }) => `${value.toFixed(1)}ms`,
              },
              data: [{ yAxis: avg }],
            }
          : undefined,
      markPoint: buildMarkPoint(s, color, opts, pal),
      // 区间色块挂在第一条序列上即可覆盖全图；标签错开两行，避免缺口与异常
      // 相邻时两个标签叠在一起
      markArea: i === 0 ? buildMarkArea(model, pal, labelBg) : undefined,
    };
  });

  const lossBars = model.lossSeries
    .filter((p) => p.loss !== null && p.loss > 0)
    .map((p) => [p.ts, p.loss]);
  if (opts.showLoss && lossBars.length) {
    series.push({
      name: "丢包",
      type: "bar",
      yAxisIndex: 1,
      barWidth: 2,
      barMinHeight: 1,
      large: true,
      data: lossBars,
      itemStyle: { color: pal.danger, opacity: 0.7 },
    });
  }
  return series;
}

// 末点小圆点标出「最新一次探测」；开了极值再叠加该目标的最高/最低点
function buildMarkPoint(s, color, opts, pal) {
  const data = [];
  const last = lastValidPoint(s.points);
  if (last) {
    data.push({
      coord: last,
      symbol: "circle",
      symbolSize: 8,
      itemStyle: { color, borderColor: "#fff", borderWidth: 1.5 },
      label: { show: false },
    });
  }
  if (opts.showMax) {
    const label = {
      show: true,
      color: pal.text,
      fontSize: 10,
      borderRadius: 6,
      padding: [2, 6],
      position: "top",
      distance: 6,
      formatter: (param) => {
        const v = Array.isArray(param.value)
          ? param.value[param.value.length - 1]
          : param.value;
        if (v === null || v === undefined || Number.isNaN(v)) return "";
        return `${Number(v).toFixed(1)}ms`;
      },
    };
    data.push({
      type: "max",
      symbol: "circle",
      symbolSize: 6,
      itemStyle: { color, opacity: 0.85 },
      label: { ...label, backgroundColor: hexToRgba(pal.danger, 0.5) },
    });
    data.push({
      type: "min",
      symbol: "circle",
      symbolSize: 6,
      itemStyle: { color, opacity: 0.85 },
      label: { ...label, backgroundColor: hexToRgba(pal.ok, 0.5) },
    });
  }
  if (!data.length) return undefined;
  return { silent: true, data };
}

function buildMarkArea(model, pal, labelBg) {
  const areas = [];
  model.gapAreas.forEach(([from, to]) => {
    areas.push([
      {
        ...from,
        itemStyle: { color: hexToRgba(pal.muted, 0.1) },
        label: {
          show: true,
          position: "insideTop",
          offset: [0, 2],
          color: pal.muted,
          backgroundColor: labelBg,
          padding: [2, 5],
          borderRadius: 4,
          fontSize: 9,
        },
      },
      to,
    ]);
  });
  model.lossAreas.forEach(([from, to]) => {
    areas.push([
      {
        ...from,
        itemStyle: { color: hexToRgba(pal.warn, 0.07) },
        label: {
          show: true,
          position: "insideTop",
          offset: [0, 20],
          color: pal.warn,
          backgroundColor: labelBg,
          padding: [2, 5],
          borderRadius: 4,
          fontSize: 9,
        },
      },
      to,
    ]);
  });
  if (!areas.length) return undefined;
  return { silent: true, data: areas };
}

/** 左轴上限取「留 15% 顶部余量」后的整齐值，好让顶格刻度带单位也是整数 */
function latencyAxisMax(series) {
  let max = 0;
  series.forEach((s) =>
    s.points.forEach((p) => {
      if (p.rtt_ms > max) max = p.rtt_ms;
    }),
  );
  if (max <= 0) return 100;
  return niceCeil(max * 1.15);
}

function averageRtt(points) {
  let sum = 0;
  let count = 0;
  points.forEach((p) => {
    if (p.rtt_ms === null || p.rtt_ms === undefined) return;
    sum += p.rtt_ms;
    count += 1;
  });
  return count ? sum / count : 0;
}

function lastValidPoint(points) {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p.rtt_ms !== null && p.rtt_ms !== undefined) return [p.ts * 1000, p.rtt_ms];
  }
  return null;
}

function tooltipHtml(params) {
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
          : p.seriesName === "丢包"
            ? `${Number(value).toFixed(1)}%`
            : `${Number(value).toFixed(1)} ms`;
      const dot = `<span style="display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>`;
      return `${dot}${escapeHtml(p.seriesName)}: ${text}`;
    })
    .join("<br/>");
  return `${time}<br/>${rows}`;
}

// setOption(…, true) 会清空 series 但不会解绑事件，所以只绑一次；
// 回调放在闭包外读最新的 onZoom，避免拿到首次渲染时的那个函数
/** @type {((zoom: {start: number, end: number}) => void) | null} */
let zoomHandler = null;

function bindZoom(onZoom) {
  zoomHandler = onZoom;
  if (!chart || zoomBound) return;
  chart.on("dataZoom", (evt) => {
    const batch = evt?.batch?.[0] ?? evt;
    if (typeof batch?.start === "number" && typeof batch?.end === "number") {
      zoomHandler?.({ start: batch.start, end: batch.end });
    }
  });
  zoomBound = true;
}
