// 延迟统计：链路状态横幅 + 6 栏指标条 + 图例行。
// 只消费 index.js 传进来的模型与缩放窗口，自己不发请求、不持有状态。

import { $, escapeHtml, setText } from "../../core/dom.js";
import { formatNumber, formatPercent, formatSpanParts } from "../../core/format.js";
import { latencyPalette, targetColor } from "./palette.js";

// 「最近」= 末尾这么多个粒度桶。单桶抖一下很常见，横幅不该跟着闪
const RECENT_BUCKETS = 5;
// 丢包到这个百分比就算劣化（设计稿给的阈值）
const LOSS_WARN_PCT = 2;
// 均值相对基线的劣化倍率。绝对阈值（如 200ms）对跨洋链路恒为真，只能用相对量；
// FLOOR 防止基线极小时（同机房 1ms）几毫秒抖动就把状态刷成劣化
const DEGRADE_RATIO = 1.5;
const DEGRADE_FLOOR_MS = 30;

const STATUS_TEXT = { ok: "链路正常", warn: "链路劣化", down: "链路中断" };

/**
 * @param {any} model buildLatencyModel 的产物
 * @param {{start: number, end: number} | null} range 当前缩放窗口
 * @param {{rangeLabel: string, rangeText: string, showLoss: boolean,
 *          zoomed: boolean}} ctx
 */
export function renderLatencyStats(model, range, ctx) {
  renderBanner(model, Date.now());
  renderMetrics(model, range, ctx);
  renderLegend(model, ctx);
}

/* -------------------------------------------------------------------------- */
/* 链路状态横幅                                                                 */
/* -------------------------------------------------------------------------- */

function renderBanner(model, now) {
  const banner = $("lat-banner");
  if (!banner) return;

  // 读数只讲焦点目标。跨目标求平均会得到一条实际不存在的链路：CU 40ms 与 GC 170ms
  // 平均出的 105ms 既不是任何一条的现状，也无法据此判断哪条出了问题
  const focus = model.series.find((s) => s.tag === model.statsTag) || model.series[0];
  const focusTag = focus?.tag || "";
  const st = deriveLinkStatus(focus ? focus.points : [], model, now);
  // 状态灯与标题按所有选中目标里最差的那条判定：焦点恰好选中健康的那条时，
  // 另一条断了也必须在横幅上看得见
  const worst = worstStatus(model, now, st, focus);

  banner.classList.remove("is-ok", "is-warn", "is-down");
  banner.classList.add(`is-${worst.status}`);
  // 数值的着色跟随焦点自身状态，否则「链路中断」会把健康焦点的读数一并染红
  banner.classList.remove("focus-ok", "focus-warn", "focus-down");
  banner.classList.add(`focus-${st.status}`);

  // 出事的不是焦点目标时点名，否则「链路中断」与旁边正常的读数无法互相解释。
  // 标题是 nowrap 的，目标多了只列两个再给总数，避免把横幅头部撑开
  const culprits = worst.status === "ok" ? [] : worst.tags.filter((t) => t && t !== focusTag);
  const culprit = culprits.length
    ? ` · ${culprits.length > 2 ? `${culprits.slice(0, 2).join("、")} 等 ${culprits.length} 条` : culprits.join("、")}`
    : "";
  setText("lat-banner-title", `${STATUS_TEXT[worst.status]}${culprit}`);

  const prefix = model.series.length > 1 && focusTag ? `${focusTag} ` : "";
  setText("lat-now-label", `${prefix}当前延迟`);
  setText("lat-now", st.status === "down" ? "--" : formatNumber(st.rtt));

  // 中断时第二格换成「已持续」——此刻「抖动多少」没有意义，「断了多久」才有
  if (st.status === "down") {
    const [value, unit] = formatSpanParts(st.downMs);
    setText("lat-second-label", "已持续");
    setText("lat-second", value);
    setText("lat-second-unit", unit);
  } else {
    setText("lat-second-label", "抖动");
    setText("lat-second", formatNumber(st.jitter));
    setText("lat-second-unit", "ms");
  }

  setText("lat-loss-now", formatPercent(st.loss));
  // 横幅的丢包取最近几个桶，指标条的丢包率取缩放窗口——同一张卡上两个「丢包」
  // 数字差得很远时，不写明各自的窗口就只会被当成自相矛盾
  const lossScope =
    st.status === "down" ? "" : ` · 丢包近 ${RECENT_BUCKETS * model.granularity} 分钟`;
  setText(
    "lat-banner-meta",
    `${st.status === "down" ? "探测失败" : formatAgo(st.ageMs)} · 粒度 ${model.granularity} 分钟${lossScope}`,
  );
}

// 状态严重度排序，用来在多个目标间挑出最差的那条
const STATUS_RANK = { ok: 0, warn: 1, down: 2 };

/**
 * 所有选中目标里最差的状态及其归属目标。焦点目标已经算过，不重复算。
 *
 * 非焦点目标只在「探测在跑、包却回不来」时才拉响横幅：没有数据、或数据已经陈旧的
 * 一律不参与判定。`client:*` 是客户端间歇上报的，`/api/latency` 只要窗口内出现过
 * 就会列出它，关掉浏览器后那个目标会带着小时级的 ageMs 在列表里滞留一整天——把它
 * 算作「链路中断」会让横幅在服务端一切正常时长期钉在红色。真停采时焦点目标自己也
 * 会陈旧并判 down，横幅照样报，这里跳过不会漏。
 *
 * @param {any} model @param {number} now @param {any} focusSt @param {any} focus
 */
function worstStatus(model, now, focusSt, focus) {
  const worst = { status: focusSt.status, tags: [focus?.tag || ""] };
  model.series.forEach((s) => {
    if (s.tag === focus?.tag || !s.points.length) return;
    const st = deriveLinkStatus(s.points, model, now);
    if (st.ageMs > model.gapMs) return;
    const rank = STATUS_RANK[st.status];
    if (rank > STATUS_RANK[worst.status]) {
      worst.status = st.status;
      worst.tags = [s.tag];
    } else if (rank === STATUS_RANK[worst.status]) {
      // 同档也要记下：两条链路同时断时只点名靠前的那个，另一条会被读成好的
      worst.tags.push(s.tag);
    }
  });
  return worst;
}

/**
 * 推导单个目标的当前状态。判据全部相对化：无数据 → 中断；最近窗口全超时 → 中断；
 * 丢包 ≥ 2% 或均值明显高于基线 → 劣化；其余正常。
 * @param {any[]} points 该目标的原始点位 @param {any} model @param {number} now
 */
function deriveLinkStatus(points, model, now) {
  const merged = buildTimeline(points);
  const empty = { status: "down", rtt: null, jitter: null, loss: null, ageMs: 0, downMs: 0 };
  if (!merged.length) return empty;

  const lastTs = merged[merged.length - 1].ts;
  const lastValid = findLastValid(merged);
  const ageMs = Math.max(0, now - lastTs);

  // 采集器停了：最新一个桶已经超过缺口阈值没有更新
  if (ageMs > model.gapMs) {
    return {
      status: "down",
      rtt: null,
      jitter: null,
      loss: 100,
      ageMs,
      downMs: Math.max(0, now - (lastValid?.ts ?? lastTs)),
    };
  }

  const from = lastTs - (RECENT_BUCKETS - 1) * model.stepMs;
  const recent = merged.filter((p) => p.ts >= from);
  const recentValid = recent.filter((p) => p.rtt !== null);
  const loss = lossRate(recent);

  // 采集在跑但一个包都没回来
  if (!recentValid.length) {
    return {
      status: "down",
      rtt: null,
      jitter: null,
      loss: loss ?? 100,
      ageMs,
      downMs: Math.max(0, now - (lastValid?.ts ?? lastTs)),
    };
  }

  const recentAvg =
    recentValid.reduce((sum, p) => sum + p.rtt, 0) / recentValid.length;
  const baseline = median(merged.map((p) => p.rtt).filter((v) => v !== null));
  const ceiling = baseline
    ? Math.max(baseline * DEGRADE_RATIO, baseline + DEGRADE_FLOOR_MS)
    : Infinity;
  const degraded = (loss ?? 0) >= LOSS_WARN_PCT || recentAvg > ceiling;

  return {
    status: degraded ? "warn" : "ok",
    rtt: lastValid ? lastValid.rtt : recentAvg,
    jitter: lastValid?.succJitter ?? averageOf(recentValid.map((p) => p.jitter)),
    loss,
    ageMs,
    downMs: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* 指标条                                                                       */
/* -------------------------------------------------------------------------- */

function renderMetrics(model, range, ctx) {
  const agg = aggregate(model, range);
  const multi = model.series.length > 1;
  const tag = multi && model.statsTag ? `${model.statsTag} · ` : "";

  setText("lat-avg-label", `${tag}${ctx.zoomed ? "选区平均" : `${ctx.rangeLabel} 平均`}`);
  setText(
    "lat-p95-label",
    `${tag}${agg.p95 !== null && !agg.p95Exact ? "P95 约" : "P95"}`,
  );
  setText("lat-avg", formatNumber(agg.avg));
  setText("lat-p95", formatNumber(agg.p95));
  setText("lat-min", formatNumber(agg.min));
  setText("lat-max", formatNumber(agg.max));
  setText("lat-loss", formatPercent(agg.loss));

  const [anomaly, anomalyUnit] = formatSpanParts(agg.anomalyMs);
  setHtmlValue("lat-anomaly", anomaly, anomalyUnit);

  // 标橙的判据是「尾部变肥」而不是「出现过一个坏包」。max 是窗口内单个最差包
  // （24h 约 3 万个样本），任何 `max > k × 中心统计量` 的判据在健康链路上都必然触发——
  // 实测健康/抖动/薄尾/跨洋四类链路里，`max>median*2` 与 `max>p95*2` 的误报率都是 100%，
  // 且后者在真劣化时反而不报。`p95 > median*2` 是四类正常链路全不报、真劣化必报的判据。
  // 角标因此挂在 P95 上：单个最差包不可行动，P95 抬高才是这条链路真的变坏了
  const spiky =
    agg.median !== null && agg.p95 !== null && agg.p95 > agg.median * 2;
  setState("lat-p95-value", spiky ? "is-warn" : "");
  setState(
    "lat-loss-value",
    agg.loss === null ? "" : agg.loss >= 10 ? "is-danger" : agg.loss >= LOSS_WARN_PCT ? "is-warn" : "",
  );
  setState("lat-anomaly-value", agg.anomalyMs > 0 ? "is-warn" : "");
}

/** 指标条上「值 + 单位」两段共用一个容器，异常时长的单位随量级变，需要重写 */
function setHtmlValue(id, value, unit) {
  const el = $(id);
  if (!el) return;
  el.textContent = value;
  const next = el.nextElementSibling;
  if (next && next.classList.contains("metric-bar-unit")) {
    next.textContent = unit;
  }
}

function setState(id, cls) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("is-warn", "is-danger");
  if (cls) el.classList.add(cls);
}

/** 在缩放窗口内汇总：整条指标条只讲焦点目标，多选时不混口径 */
function aggregate(model, range) {
  const focus =
    model.series.find((s) => s.tag === model.statsTag) || model.series[0];
  const rtt = focus ? aggregateFocus(focus.points, range) : emptyRtt();

  let sent = 0;
  let lost = 0;
  (focus ? focus.points : []).forEach((p) => {
    if (!inRange(p.ts * 1000, range)) return;
    sent += p.sent || 0;
    lost += p.lost || 0;
  });

  return {
    ...rtt,
    loss: sent > 0 ? (lost / sent) * 100 : null,
    anomalyMs: anomalyMs(model, range),
  };
}

function emptyRtt() {
  return {
    avg: null,
    p95: null,
    p95Exact: true,
    median: null,
    min: null,
    max: null,
  };
}

/** @param {any[]} points @param {{start:number,end:number}|null} range */
function aggregateFocus(points, range) {
  /** @type {number[]} */
  const samples = [];
  /** @type {number[]} */
  const bucketP95 = [];
  /** @type {number[]} */
  const bucketAvgs = [];
  let completeSamples = true;
  let min = Infinity;
  let max = -Infinity;
  let sumRtt = 0;
  let recv = 0;

  points.forEach((p) => {
    if (!inRange(p.ts * 1000, range)) return;
    const minC = num(p.min_rtt) ?? num(p.rtt_ms);
    const maxC = num(p.max_rtt) ?? num(p.rtt_ms);
    if (minC !== null && minC < min) min = minC;
    if (maxC !== null && maxC > max) max = maxC;

    const rtts = Array.isArray(p.rtts) ? p.rtts.filter((v) => num(v) !== null) : [];
    const rec = p.recv || rtts.length;
    if (rec > 0 && rtts.length === 0) completeSamples = false;
    if (rtts.length) samples.push(...rtts);

    if (typeof p.sum_rtt === "number") sumRtt += p.sum_rtt;
    else if (rtts.length) sumRtt += rtts.reduce((a, b) => a + b, 0);
    else if (num(p.rtt_ms) !== null && rec) sumRtt += num(p.rtt_ms) * rec;
    recv += rec;

    if (num(p.p95) !== null) bucketP95.push(/** @type {number} */ (num(p.p95)));
    if (num(p.rtt_ms) !== null) bucketAvgs.push(/** @type {number} */ (num(p.rtt_ms)));
  });

  if (completeSamples && samples.length) {
    const sorted = samples.slice().sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    return {
      avg,
      p95: percentileNearestRank(sorted, 0.95),
      p95Exact: true,
      median: median(sorted),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  let avg = null;
  if (recv > 0 && sumRtt > 0) avg = sumRtt / recv;
  else if (bucketAvgs.length) avg = bucketAvgs.reduce((a, b) => a + b, 0) / bucketAvgs.length;
  const p95Sorted = bucketP95.slice().sort((a, b) => a - b);
  return {
    avg,
    p95: p95Sorted.length ? percentileNearestRank(p95Sorted, 0.95) : null,
    p95Exact: false,
    median: median(bucketAvgs),
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
  };
}

/** @param {number} ts @param {{start:number,end:number}|null} range */
function inRange(ts, range) {
  if (range?.start != null && ts < range.start) return false;
  if (range?.end != null && ts > range.end) return false;
  return true;
}

function num(v) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
}

/** 近邻秩，与后端 percentileNearestRank 一致：rank = ceil(p*n) */
function percentileNearestRank(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[n - 1];
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sorted[rank - 1];
}

// 异常时长：连续超阈值的丢包桶各自占一个粒度宽度，累加即为总时长
function anomalyMs(model, range) {
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  const points = model.focusLossSeries || model.lossSeries;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (start !== null && p.ts < start) continue;
    if (end !== null && p.ts > end) continue;
    if (p.loss === null || p.loss < model.lossThresholdPct) continue;
    const next = points[i + 1];
    total += Math.max(0, next ? next.ts - p.ts : model.stepMs);
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* 图例行                                                                       */
/* -------------------------------------------------------------------------- */

function renderLegend(model, ctx) {
  const colors = latencyPalette();
  const html = model.series
    .map((s) => {
      const color = targetColor(colors, s.idx);
      return `<span class="lat-legend-item is-target"><span class="lat-dot" style="background:${color}"></span>${escapeHtml(s.tag)}</span>`;
    })
    .join("");
  const targets = $("lat-legend-targets");
  if (targets) targets.innerHTML = html;

  const loss = $("lat-legend-loss");
  if (loss) loss.hidden = !ctx.showLoss;
  const p95Leg = $("lat-legend-p95");
  if (p95Leg) p95Leg.hidden = !ctx.showP95;

  // 缩放后指标条只算窗口内的点，图例这行是唯一还写着完整查询范围的地方，
  // 不点破就会被读成「这些数字是整段区间的」
  const scope = ctx.zoomed ? " · 指标取自当前选区" : "";
  // 指标条整行都是焦点目标的读数，但只有平均/P95 两个标签带得下前缀，
  // 多目标时在这里把范围点破一次，避免「最大/丢包」被读成所有目标的合计
  const focusNote =
    model.series.length > 1 && model.statsTag ? ` · 指标目标 ${model.statsTag}` : "";
  setText(
    "lat-legend-meta",
    `采样 ${model.sampleCount} 点 · ${model.granularity} 分钟粒度 · ${ctx.rangeText}${focusNote}${scope}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                         */
/* -------------------------------------------------------------------------- */

/** 把一个目标的点位整理成状态判定用的时间线 */
function buildTimeline(points) {
  return points
    .map((p) => ({
      ts: p.ts * 1000,
      rtt: num(p.rtt_ms),
      jitter: num(p.jitter),
      succJitter: Array.isArray(p.rtts) && p.rtts.length ? meanSuccessiveDiff(p.rtts) : null,
      sent: p.sent || 0,
      lost: p.lost || 0,
    }))
    .sort((a, b) => a.ts - b.ts);
}

function meanSuccessiveDiff(values) {
  if (!values || values.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < values.length; i++) {
    sum += Math.abs(values[i] - values[i - 1]);
  }
  return sum / (values.length - 1);
}

function findLastValid(merged) {
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].rtt !== null) return merged[i];
  }
  return null;
}

function lossRate(rows) {
  const sent = rows.reduce((n, p) => n + p.sent, 0);
  const lost = rows.reduce((n, p) => n + p.lost, 0);
  return sent > 0 ? (lost / sent) * 100 : null;
}

function median(values) {
  const list = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function averageOf(values) {
  const list = values.filter((v) => v !== null && v !== undefined);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function formatAgo(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒前更新`;
  return `${Math.round(sec / 60)} 分钟前更新`;
}
