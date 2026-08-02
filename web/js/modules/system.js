// 系统状态卡片：初次由 /api/system 拉取，之后由 SSE 的 system 事件驱动

import { $, setText } from "../core/dom.js";
import { formatBytes, formatBytesParts, formatUptime } from "../core/format.js";
import { getJSON, logFetchError, HttpError } from "../core/http.js";
import { onStreamEvent } from "../core/stream.js";

// 近 1 分钟均值高于该值说明宿主机被超售，值得提示。
// 判定用均值而非瞬时值：单轮 steal 抖到 1% 很常见，会让角标反复闪烁
const stealWarnPercent = 1;
// 重传率经验阈值：1% 已能感知卡顿，3% 以上基本可以判定线路劣化
const retransWarnPercent = 1;
const retransDangerPercent = 3;
// 占用率类指标（CPU/内存/磁盘/负载）共用一套阈值，避免每张卡各说各话
const usageWarnPercent = 70;
const usageDangerPercent = 90;

export function initSystem() {
  // 系统状态与实时网速共用同一条 SSE，但彼此不知情：网速模块整个重写也不会波及这里
  onStreamEvent("system", renderSystem);
  refreshSystem();
}

// 获取系统资源
export async function refreshSystem() {
  try {
    renderSystem(await getJSON("/api/system", { noStore: true }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      console.error("服务端 API 不存在，请检查 heliox-mon 服务是否正常运行");
    }
    logFetchError("获取系统数据失败:", e);
  }
}

// levelOf 把占用率映射成状态等级，角标与进度条共用同一判定
function levelOf(percent) {
  if (percent >= usageDangerPercent) return "is-danger";
  if (percent >= usageWarnPercent) return "is-warn";
  return "";
}

// tagFor 按等级挑该指标自己的措辞：阈值一套，但每张卡说自己的人话
function tagFor(level, words) {
  if (level === "is-danger") return words[2];
  if (level === "is-warn") return words[1];
  return words[0];
}

// setTag 写状态角标；text 为空表示这一轮没有可信数据，直接不占位
function setTag(id, text, level) {
  const el = $(id);
  el.classList.remove("is-warn", "is-danger", "is-info", "is-hidden");
  if (!text) {
    el.textContent = "";
    el.classList.add("is-hidden");
    return;
  }
  el.textContent = text;
  if (level) el.classList.add(level);
}

// setBar 设置进度条宽度与状态色。非零但极小的占比给一个最小可见宽度，
// 否则「有一点点」和「完全没有」在视觉上无法区分
function setBar(id, percent, level) {
  const el = $(id);
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  el.style.width = value + "%";
  el.style.minWidth = value > 0 ? "3px" : "0";
  el.classList.remove("is-warn", "is-danger");
  if (level) el.classList.add(level);
}

function renderSystem(data) {
  renderCPU(data);
  renderMemory(data);
  renderDisk(data);
  renderLoad(data);
  renderConnections(data);
  renderRetrans(data);
  renderUptime(data);
}

// renderCPU 使用率 + 核数，宿主机抢占明显时并入副信息
function renderCPU(data) {
  // 采集器刚启动时还没有两次采样的差值，cpu_percent 为 null
  const valid = data.cpu_percent !== null && data.cpu_percent !== undefined;
  const value = valid ? Number(data.cpu_percent) : 0;
  const level = valid ? levelOf(value) : "";

  $("cpu").textContent = valid ? value.toFixed(1) : "--";
  setBar("cpu-bar", value, level);
  setTag("cpu-tag", valid ? tagFor(level, ["空闲", "繁忙", "过载"]) : "", level);

  const cores = Number(data.cpu_cores) || 0;
  const steal = Number(data.steal_avg_percent) || 0;
  // steal 平时是 0，只有被宿主机抢占时才值得占用视觉空间
  const stealing = steal >= stealWarnPercent;
  // 核数与抢占分成两段：只有抢占那段染成警告色，核数是中性事实
  $("cpu-cores").textContent = cores ? cores + " 核" : "";
  $("cpu-steal").textContent = stealing
    ? (cores ? " · " : "") + "宿主机抢占 " + steal.toFixed(1) + "%"
    : "";
}

function renderMemory(data) {
  const used = Number(data.mem_used) || 0;
  const total = Number(data.mem_total) || 0;
  const percent = total ? (used / total) * 100 : 0;
  const level = levelOf(percent);
  const [value, unit] = formatBytesParts(used);

  $("memory").textContent = value;
  $("memory-unit").textContent = unit + " / " + formatBytes(total);
  setBar("memory-bar", percent, level);
  setTag(
    "memory-tag",
    total ? tagFor(level, ["充裕", "偏高", "紧张"]) : "",
    level,
  );
  $("memory-note").textContent = total
    ? percent.toFixed(0) +
      "% 已用 · 可用 " +
      formatBytes(Math.max(total - used, 0))
    : "";
}

function renderDisk(data) {
  const used = Number(data.disk_used) || 0;
  const total = Number(data.disk_total) || 0;
  const percent = total ? (used / total) * 100 : 0;
  const level = levelOf(percent);
  const [value, unit] = formatBytesParts(used);

  $("disk").textContent = value;
  $("disk-unit").textContent = unit + " / " + formatBytes(total);
  setBar("disk-bar", percent, level);
  setTag("disk-tag", total ? tagFor(level, ["健康", "注意", "告警"]) : "", level);
  // 剩余按 disk_avail 显示：普通用户真正能写入的容量，
  // 比 total - used 少掉文件系统预留给 root 的部分
  $("disk-note").textContent = total
    ? percent.toFixed(0) + "% 已用 · 可用 " + formatBytes(data.disk_avail)
    : "";
}

// renderLoad 负载按核数换算成百分比再套统一阈值，省得用户自己心算
function renderLoad(data) {
  const cores = Number(data.cpu_cores) || 0;
  const items = [
    { id: "1", value: Number(data.load_1) || 0 },
    { id: "5", value: Number(data.load_5) || 0 },
    { id: "15", value: Number(data.load_15) || 0 },
  ];

  $("load-1").textContent = items[0].value.toFixed(2);

  const level = cores ? levelOf((items[0].value / cores) * 100) : "";
  setTag(
    "load-tag",
    cores ? Math.round((items[0].value / cores) * 100) + "% 负载率" : "",
    level,
  );

  items.forEach((item) => {
    const percent = cores ? (item.value / cores) * 100 : 0;
    setBar("load-bar-" + item.id, percent, cores ? levelOf(percent) : "");
    $("load-text-" + item.id).textContent =
      item.id + "m " + item.value.toFixed(2);
  });
}

// renderConnections 活跃连接数，分段条与副信息按端口拆分。
// 后端读不到 /proc/net/tcp 时返回 null，显示占位符而不是把「没读到」画成 0
function renderConnections(data) {
  const available = data.conns_total !== undefined && data.conns_total !== null;
  $("conns").textContent = available ? data.conns_total : "--";

  const ports = available ? data.conns_by_port || [] : [];
  setTag("conns-tag", ports.length ? ports.length + " 端口" : "", "is-info");

  // 各段宽度按连接数占比分配；某端口为 0 时退化成一个最小占位块
  $("conns-seg").innerHTML = ports
    .map((item) => {
      const count = Number(item.count) || 0;
      return count > 0
        ? '<div class="stat-seg-item" style="flex:' + count + '"></div>'
        : '<div class="stat-seg-item is-empty"></div>';
    })
    .join("");

  $("conns-detail").textContent = ports
    .map((item) => item.port + " · " + item.count)
    .join("　");
}

// renderRetrans TCP 重传率，超过阈值时变色
function renderRetrans(data) {
  const note = $("retrans-note");

  // 没有两次采样的差值时不伪造 0%
  if (data.retrans_percent === null || data.retrans_percent === undefined) {
    $("retrans").textContent = "--";
    setBar("retrans-bar", 0, "");
    setTag("retrans-tag", "", "");
    note.textContent = "";
    return;
  }

  const value = Number(data.retrans_percent);
  let level = "";
  if (value >= retransDangerPercent) level = "is-danger";
  else if (value >= retransWarnPercent) level = "is-warn";

  $("retrans").textContent = value.toFixed(2);
  // 重传率没有「总量」概念，进度条以 danger 阈值为满刻度，纯作趋势示意
  setBar("retrans-bar", (value / retransDangerPercent) * 100, level);
  setTag("retrans-tag", tagFor(level, ["线路正常", "质量下降", "丢包严重"]), level);
  note.textContent =
    "阈值 " +
    retransWarnPercent +
    "% · " +
    (value > 0 ? "近期有重传" : "无丢包重传");
}

function renderUptime(data) {
  const pill = $("uptime-pill");
  const text = formatUptime(data.uptime_sec);
  setText("uptime", text);
  pill.hidden = text === "--";
}
