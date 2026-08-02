// 流量统计：本月/今日/昨日总量、配额进度条、按端口明细

import { $, escapeHtml, setHtml, setText } from "../core/dom.js";
import { formatBytes } from "../core/format.js";
import { getJSON, logFetchError } from "../core/http.js";

export function initTraffic() {
  refreshTraffic();
}

// 获取仪表盘数据
export async function refreshTraffic() {
  try {
    const data = await getJSON("/api/stats");

    document.title = data.server_name;
    // 只写文本节点，胶囊里的铃铛图标不能被整体覆盖掉
    setText("server-name-text", data.server_name);
    $("current-time").textContent = data.current_time;

    // 流量数据
    setText("today-tx", `↑ ${formatBytes(data.today.tx)}`);
    setText("today-rx", `↓ ${formatBytes(data.today.rx)}`);
    setText("today-total", `⇅ ${formatBytes(data.today.tx + data.today.rx)}`);

    setText("yesterday-tx", `↑ ${formatBytes(data.yesterday.tx)}`);
    setText("yesterday-rx", `↓ ${formatBytes(data.yesterday.rx)}`);
    setText(
      "yesterday-total",
      `⇅ ${formatBytes(data.yesterday.tx + data.yesterday.rx)}`,
    );

    // 本月总计
    const monthTotalBytes = data.this_month.tx + data.this_month.rx;
    const monthTotalGB = (monthTotalBytes / 1024 / 1024 / 1024).toFixed(2);
    $("month-total").textContent = monthTotalGB + " GB";

    // 获取端口流量
    fetchPortTraffic();

    // 渲染高级流量进度条
    renderTrafficProgress(data);
  } catch (e) {
    logFetchError("获取统计数据失败:", e);
  }
}

// 渲染流量进度条（支持双向/单向/刻度）
function renderTrafficProgress(data) {
  const limitGB = data.monthly_limit_gb;
  if (limitGB <= 0) return;

  const usedBytes = data.used_bytes;
  const usedGB = Math.round(usedBytes / 1024 / 1024 / 1024);
  const totalPercent = (usedBytes / (limitGB * 1024 * 1024 * 1024)) * 100;

  // 更新文本
  setText("quota-used", usedGB);
  setText("quota-limit", limitGB);
  setText("quota-percent-text", `${totalPercent.toFixed(1)}%`);
  setText("reset-day", data.reset_day);

  // 更新 Badge
  const badgeEl = $("billing-mode-badge");
  if (badgeEl) {
    let modeText = data.billing_mode;
    if (modeText === "bidirectional") modeText = "双向计费";
    else if (modeText === "tx_only") modeText = "仅出站 (TX)";
    else if (modeText === "rx_only") modeText = "仅入站 (RX)";
    else if (modeText === "max_value") modeText = "取最大值 (Max)";
    badgeEl.textContent = modeText;
  }

  // 渲染进度条轨道
  const track = $("progress-track");
  if (!track) return;
  track.innerHTML = ""; // 清空

  // 1. 添加刻度 (Threshold Markers)
  const thresholds =
    data.alert_thresholds && data.alert_thresholds.length > 0
      ? data.alert_thresholds
      : [80, 90, 95];
  thresholds.forEach((t) => {
    if (t > 0 && t < 100) {
      const marker = document.createElement("div");
      marker.className = "threshold-marker";
      marker.style.left = `${t}%`;
      marker.title = `预警阈值: ${t}%`;
      track.appendChild(marker);
    }
  });

  // 2. 计算分段
  const limitBytes = limitGB * 1024 * 1024 * 1024;
  const segments = [];
  let isDanger = false;

  // 检查是否超过最小阈值 (通常是第一个)
  const sortedThresholds = [...thresholds].sort((a, b) => a - b);
  if (sortedThresholds.length > 0 && totalPercent >= sortedThresholds[0]) {
    isDanger = true;
  }

  // 根据模式决定渲染段
  if (data.billing_mode === "bidirectional") {
    // 双向：分开显示 TX 和 RX
    const txPercent = (data.this_month.tx / limitBytes) * 100;
    const rxPercent = (data.this_month.rx / limitBytes) * 100;
    segments.push({ type: "tx", width: txPercent });
    segments.push({ type: "rx", width: rxPercent });
  } else {
    // 单向或其他：显示总计 (tx_only, rx_only, max_value)
    // 注意：max_value 模式下 used_bytes 已是 max(tx, rx)
    segments.push({ type: "total", width: totalPercent });
  }

  // 3. 渲染分段
  segments.forEach((seg) => {
    const div = document.createElement("div");
    div.className = `progress-bar-segment segment-${seg.type}`;
    div.style.width = `${Math.min(seg.width, 100).toFixed(2)}%`; // 防止溢出视觉
    track.appendChild(div);
  });

  // 4. 变红逻辑
  if (isDanger) {
    track.classList.add("danger");
  } else {
    track.classList.remove("danger");
  }
}

// 获取端口流量
async function fetchPortTraffic() {
  try {
    const data = await getJSON("/api/traffic/ports");

    if (!data.ports || data.ports.length === 0) {
      // 显示提示信息
      setHtml(
        "port-traffic-today",
        '<div class="port-no-data">暂无端口流量数据</div>',
      );
      return;
    }

    // 检查 iptables 规则状态
    if (data.iptables_ok === false) {
      setHtml(
        "port-traffic-today",
        '<div class="port-warning">⚠️ iptables 规则未完整配置（TCP/UDP），请运行 setup-iptables.sh</div>',
      );
      return;
    }

    // 渲染今日端口流量
    renderPortList("port-traffic-today", data.ports, "today");
    // 渲染昨日端口流量
    renderPortList("port-traffic-yesterday", data.ports, "yesterday");
    // 渲染本月端口流量
    renderPortMonthGrid("port-traffic-month", data.ports);
  } catch (e) {
    logFetchError("获取端口流量失败:", e);
  }
}

// 渲染端口流量列表
function renderPortList(containerId, ports, period) {
  const container = $(containerId);
  if (!container) return;

  container.innerHTML = ports
    .map((p) => {
      const d = p[period];
      const name = escapeHtml(p.name.toLowerCase());
      // 使用 Grid 布局：第一行名称，第二行三组数据
      return `
      <div class="port-item ${name}">
        <span class="port-name">${name}</span>
        <div class="port-stats">
          <div class="stats-group-up">
            <span class="stat-up">↑ ${formatBytes(d.tx)}</span>
          </div>
          <div class="stats-group-down">
            <span class="stat-down">↓ ${formatBytes(d.rx)}</span>
          </div>
          <div class="stats-group-total">
            <span class="stat-total">⇅ ${formatBytes(d.total)}</span>
          </div>
        </div>
      </div>
    `;
    })
    .join("");
}

// 渲染本月端口流量网格
function renderPortMonthGrid(containerId, ports) {
  const container = $(containerId);
  if (!container) return;

  container.innerHTML = ports
    .map((p) => {
      const d = p.this_month;
      const gb = (d.total / 1024 / 1024 / 1024).toFixed(2);
      return `
      <div class="month-item">
        <div class="port-name">${escapeHtml(p.name.toLowerCase())}</div>
        <div class="port-value">${gb} GB</div>
      </div>
    `;
    })
    .join("");
}
