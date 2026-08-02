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
 *          lossThreshold: number}} ctx
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

  const st = deriveLinkStatus(model, now);
  banner.classList.remove("is-ok", "is-warn", "is-down");
  banner.classList.add(`is-${st.status}`);
  setText("lat-banner-title", STATUS_TEXT[st.status]);

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
  setText(
    "lat-banner-meta",
    `${st.status === "down" ? "探测失败" : formatAgo(st.ageMs)} · 粒度 ${model.granularity} 分钟`,
  );
}

/**
 * 推导链路当前状态。判据全部相对化：无数据 → 中断；最近窗口全超时 → 中断；
 * 丢包 ≥ 2% 或均值明显高于基线 → 劣化；其余正常。
 */
function deriveLinkStatus(model, now) {
  const merged = mergeByBucket(model.series);
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
    jitter: averageOf(recentValid.map((p) => p.jitter)),
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

  setText("lat-avg-label", `${ctx.rangeLabel} 平均`);
  setText("lat-avg", formatNumber(agg.avg));
  setText("lat-p95", formatNumber(agg.p95));
  setText("lat-min", formatNumber(agg.min));
  setText("lat-max", formatNumber(agg.max));
  setText("lat-loss", formatPercent(agg.loss));

  const [anomaly, anomalyUnit] = formatSpanParts(agg.anomalyMs);
  setHtmlValue("lat-anomaly", anomaly, anomalyUnit);

  // 最大值只在明显高于中位数时才标橙：一条 300ms 的跨洋链路，300ms 的最大值是常态
  const spiky =
    agg.median !== null && agg.max !== null && agg.max > agg.median * 2;
  setState("lat-max-value", spiky ? "is-warn" : "");
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

/** 在缩放窗口内把所有选中目标折算成一组汇总指标 */
function aggregate(model, range) {
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  /** @type {number[]} */
  const rtts = [];
  let min = Infinity;
  let max = -Infinity;
  let sent = 0;
  let lost = 0;

  model.series.forEach((s) => {
    s.points.forEach((p) => {
      const ts = p.ts * 1000;
      if (start !== null && ts < start) return;
      if (end !== null && ts > end) return;
      if (p.rtt_ms !== null && p.rtt_ms !== undefined) {
        rtts.push(p.rtt_ms);
        // min 优先用服务端记录的真实最小 RTT，旧数据无该字段时退回桶均值
        const candidate =
          p.min_rtt !== null && p.min_rtt !== undefined ? p.min_rtt : p.rtt_ms;
        if (candidate < min) min = candidate;
        if (p.rtt_ms > max) max = p.rtt_ms;
      }
      sent += p.sent || 0;
      lost += p.lost || 0;
    });
  });

  const sorted = rtts.slice().sort((a, b) => a - b);
  return {
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
    median: median(sorted),
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
    loss: sent > 0 ? (lost / sent) * 100 : null,
    anomalyMs: anomalyMs(model, range),
  };
}

// 异常时长：连续超阈值的丢包桶各自占一个粒度宽度，累加即为总时长
function anomalyMs(model, range) {
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  const points = model.lossSeries;
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

  setText(
    "lat-legend-meta",
    `采样 ${model.sampleCount} 点 · ${model.granularity} 分钟粒度 · ${ctx.rangeText}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                         */
/* -------------------------------------------------------------------------- */

/** 把多个目标压成一条按时间桶对齐的时间线，供状态判定使用 */
function mergeByBucket(series) {
  /** @type {Map<number, {ts: number, rtts: number[], jitters: number[], sent: number, lost: number}>} */
  const map = new Map();
  series.forEach((s) => {
    s.points.forEach((p) => {
      const ts = p.ts * 1000;
      const row = map.get(ts) || { ts, rtts: [], jitters: [], sent: 0, lost: 0 };
      if (p.rtt_ms !== null && p.rtt_ms !== undefined) row.rtts.push(p.rtt_ms);
      if (p.jitter !== null && p.jitter !== undefined) row.jitters.push(p.jitter);
      row.sent += p.sent || 0;
      row.lost += p.lost || 0;
      map.set(ts, row);
    });
  });
  return Array.from(map.values())
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({
      ts: row.ts,
      rtt: row.rtts.length ? row.rtts.reduce((a, b) => a + b, 0) / row.rtts.length : null,
      jitter: row.jitters.length
        ? row.jitters.reduce((a, b) => a + b, 0) / row.jitters.length
        : null,
      sent: row.sent,
      lost: row.lost,
    }));
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
