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
/** 供 rescaleAxis 在缩放回调里重建左轴用，每次 render 刷新 @type {any} */
let axisCtx = null;

// 丢包只占图高的下 1/4：100% 丢包若顶到天花板，一分钟的抖动就把延迟曲线
// 拦腰切断，视觉权重远超它的实际信息量。右轴量程放到 4 倍，标签只标到 100%
const LOSS_AXIS_MAX = 400;

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

  const yMax = latencyAxisMax(model.series, model.timeRange, opts.zoom);
  const series = buildSeries(model, opts, { pal, colors, light, labelBg });
  // 缩放时要就地重算左轴，那一刻拿不到 render 的入参，只能在这里留一份
  axisCtx = { model, pal, gridLine };

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
      latencyYAxis(yMax, pal, gridLine),
      {
        type: "value",
        show: opts.showLoss,
        min: 0,
        max: LOSS_AXIS_MAX,
        interval: 50,
        axisLine: { show: false },
        axisTick: { show: false },
        // 量程 4 倍于实际值域，100% 以上是留白，不该标出来误导读数
        axisLabel: {
          color: pal.axis,
          fontSize: 10,
          margin: 8,
          formatter: (v) => (v > 100 ? "" : v >= 100 ? "{hot|100%}" : `${v}`),
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

  // 多带的 lost/sent 两维只供 tooltip 读，encode 里没有它们，不参与渲染
  const lossBars = model.lossSeries
    .filter((p) => p.loss !== null && p.loss > 0)
    .map((p) => [p.ts, p.loss, p.lost, p.sent]);
  if (opts.showLoss && lossBars.length) {
    series.push(lossBandSeries(lossBars, model.stepMs, pal));
  }
  return series;
}

// 丢包画成「一个粒度桶那么宽的贴底色块」，而不是固定像素宽的柱子：柱宽不随
// 缩放变化时，放大后一分钟的丢包看起来像一条把图切断的分隔线，而不是一段区间。
// custom 直接按时间坐标算宽度，桶有多宽色块就有多宽。
function lossBandSeries(data, stepMs, pal) {
  return {
    name: "丢包",
    type: "custom",
    yAxisIndex: 1,
    z: 3,
    data,
    encode: { x: 0, y: 1 },
    itemStyle: { color: pal.danger, opacity: 0.75 },
    renderItem: (params, api) => {
      const ts = api.value(0);
      const top = api.coord([ts, api.value(1)]);
      const base = api.coord([ts + stepMs, 0]);
      const sys = params.coordSys;
      const shape = echarts.graphic.clipRectByRect(
        {
          x: top[0],
          y: top[1],
          // 粒度桶窄于 1px 时（7 天视图）仍要看得见；留 1px 缝，避免连续丢包
          // 糊成一整面红墙而看不出有几段
          width: Math.max(2, base[0] - top[0] - 1),
          height: base[1] - top[1],
        },
        { x: sys.x, y: sys.y, width: sys.width, height: sys.height },
      );
      return shape ? { type: "rect", shape, style: api.style() } : undefined;
    },
  };
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
  // 丢包用 danger 色而非 warn：100% 丢包时折线本来就断开，与灰色的「无数据」
  // 缺口长得一模一样，只有颜色能说明「链路还在、但包全丢了」
  model.lossAreas.forEach(([from, to]) => {
    areas.push([
      {
        ...from,
        // 满幅色块在 24h 全景下是「找得到这一分钟」的唯一线索，所以保留；但同一层
        // 淡红 2px 宽时是标记、150px 宽时就是一堵墙，浓度必须压到底色级别
        itemStyle: { color: hexToRgba(pal.danger, 0.06) },
        label: {
          show: Boolean(from.name),
          position: "insideTop",
          offset: [0, 20],
          color: pal.danger,
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

function latencyYAxis(yMax, pal, gridLine) {
  return {
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
  };
}

/**
 * 左轴上限取「留 15% 顶部余量」后的整齐值，好让顶格刻度带单位也是整数。
 * 只统计缩放窗口内的点：轴按整段数据定死时，白天一个 400ms 的尖峰会让夜里
 * 那段 160ms 的曲线永远被压在图底三分之一，放大看细节这件事就白做了。
 */
function latencyAxisMax(series, timeRange, zoom) {
  const win = zoomWindow(timeRange, zoom);
  let max = 0;
  series.forEach((s) =>
    s.points.forEach((p) => {
      const ts = p.ts * 1000;
      if (win && (ts < win.start || ts > win.end)) return;
      if (p.rtt_ms > max) max = p.rtt_ms;
    }),
  );
  // 窗口里一个有效点都没有（整段全丢）时给个兜底量程，否则 interval 会算成 0
  if (max <= 0) return 100;
  return niceCeil(max * 1.15);
}

/** dataZoom 的 start/end 是相对数据全长的百分比，与 index.js 的 zoomRange 同源 */
function zoomWindow(timeRange, zoom) {
  if (!timeRange || !zoom) return null;
  const span = timeRange.max - timeRange.min;
  if (span <= 0) return null;
  const start = zoom.start ?? 0;
  const end = zoom.end ?? 100;
  if (start <= 0 && end >= 100) return null;
  return {
    start: timeRange.min + (span * start) / 100,
    end: timeRange.min + (span * end) / 100,
  };
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
      // 延迟为 null 说明这个桶一个包都没回来。此前这行写「丢包」，和下面的丢包
      // 序列同名，一条 tooltip 里三个「丢包」反而看不出各自在说什么
      const text =
        value === null || value === undefined
          ? isGap
            ? "无数据"
            : "无回包"
          : p.seriesName === "丢包"
            ? lossText(p)
            : `${Number(value).toFixed(1)} ms`;
      const dot = `<span style="display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>`;
      return `${dot}${escapeHtml(p.seriesName)}: ${text}`;
    })
    .join("<br/>");
  return `${time}<br/>${rows}`;
}

// 丢包率后面缀上原始计数：1 分钟粒度的 40% 不过是 5 个包丢了 2 个，10 分钟粒度
// 的 40% 背后是几十个包。没有分母就无从判断这个百分比值不值得当真
function lossText(p) {
  const pct = `${Number(p.value[1]).toFixed(1)}%`;
  const lost = p.value[2];
  const sent = p.value[3];
  if (!Number.isFinite(sent) || sent <= 0) return pct;
  return `${pct} · ${lost}/${sent} 包`;
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
      const zoom = { start: batch.start, end: batch.end };
      rescaleAxis(zoom);
      zoomHandler?.(zoom);
    }
  });
  zoomBound = true;
}

// 缩放时只 merge 左轴，不走整图 setOption：滚轮会连续触发，重建整张图既卡顿，
// 又要和正在进行的手势抢 dataZoom 状态。yAxis 只给一项，右轴按下标保持不变
function rescaleAxis(zoom) {
  if (!chart || !axisCtx) return;
  const { model, pal, gridLine } = axisCtx;
  const yMax = latencyAxisMax(model.series, model.timeRange, zoom);
  chart.setOption({ yAxis: [latencyYAxis(yMax, pal, gridLine)] });
}
