// Heliox Monitor 前端

// 工具函数
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(1) + " B/s";
  if (bytesPerSec < 1024 * 1024)
    return (bytesPerSec / 1024).toFixed(1) + " KB/s";
  return (bytesPerSec / 1024 / 1024).toFixed(2) + " MB/s";
}

// 获取仪表盘数据
async function fetchStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    document.getElementById("server-name").textContent = data.server_name;
    document.getElementById("current-time").textContent = data.current_time;

    // 流量数据
    document.getElementById("today-tx").textContent =
      "↑ " + formatBytes(data.today.tx);
    document.getElementById("today-rx").textContent =
      "↓ " + formatBytes(data.today.rx);
    document.getElementById("yesterday-tx").textContent =
      "↑ " + formatBytes(data.yesterday.tx);
    document.getElementById("yesterday-rx").textContent =
      "↓ " + formatBytes(data.yesterday.rx);

    // 本月总计
    const monthTotalBytes = data.this_month.tx + data.this_month.rx;
    const monthTotalGB = (monthTotalBytes / 1024 / 1024 / 1024).toFixed(2);
    document.getElementById("month-total").textContent = monthTotalGB + " GB";

    // 配额（使用后端根据 billing_mode 计算的 used_bytes）
    const usedGB = Math.round(data.used_bytes / 1024 / 1024 / 1024);
    const limitGB = data.monthly_limit_gb;
    const percent = limitGB > 0 ? Math.round((usedGB / limitGB) * 100) : 0;

    document.getElementById("quota-used").textContent = usedGB;
    document.getElementById("quota-limit").textContent = limitGB;
    document.getElementById("quota-percent").textContent = percent;
    document.getElementById("reset-day").textContent = data.reset_day;

    const quotaFill = document.getElementById("quota-fill");
    quotaFill.style.width = Math.min(percent, 100) + "%";
    quotaFill.classList.remove("warning", "danger");
    if (percent >= 90) quotaFill.classList.add("danger");
    else if (percent >= 80) quotaFill.classList.add("warning");

    // 获取端口流量
    fetchPortTraffic();
  } catch (e) {
    console.error("获取统计数据失败:", e);
  }
}

// 获取端口流量
async function fetchPortTraffic() {
  try {
    const res = await fetch("/api/traffic/ports");
    const data = await res.json();
    console.log("端口流量 API 返回:", data);

    if (!data.ports || data.ports.length === 0) {
      console.log("无端口配置或数据");
      // 显示提示信息
      const todayEl = document.getElementById("port-traffic-today");
      if (todayEl) todayEl.innerHTML = '<div class="port-no-data">暂无端口流量数据</div>';
      return;
    }

    // 渲染今日端口流量
    renderPortList("port-traffic-today", data.ports, "today");
    // 渲染昨日端口流量
    renderPortList("port-traffic-yesterday", data.ports, "yesterday");
    // 渲染本月端口流量
    renderPortMonthGrid("port-traffic-month", data.ports);
  } catch (e) {
    console.error("获取端口流量失败:", e);
  }
}

// 渲染端口流量列表
function renderPortList(containerId, ports, period) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = ports
    .map((p) => {
      const d = p[period];
      const cssClass = p.name.toLowerCase();
      return `
      <div class="port-item ${cssClass}">
        <span class="port-name">${p.name}</span>
        <div class="port-stats">
          <span class="stat-down">↓ ${formatBytes(d.rx)}</span>
          <span class="stat-up">↑ ${formatBytes(d.tx)}</span>
          <span class="stat-total">⇅ ${formatBytes(d.total)}</span>
        </div>
      </div>
    `;
    })
    .join("");
}

// 渲染本月端口流量网格
function renderPortMonthGrid(containerId, ports) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = ports
    .map((p) => {
      const d = p.this_month;
      const gb = (d.total / 1024 / 1024 / 1024).toFixed(2);
      return `
      <div class="month-item">
        <div class="port-name">${p.name}</div>
        <div class="port-value">${gb} GB</div>
      </div>
    `;
    })
    .join("");
}

// 获取系统资源
async function fetchSystem() {
  try {
    const res = await fetch("/api/system");
    const data = await res.json();

    document.getElementById("cpu").textContent =
      data.cpu_percent.toFixed(1) + "%";
    document.getElementById("memory").textContent =
      formatBytes(data.mem_used) + " / " + formatBytes(data.mem_total);
    document.getElementById("disk").textContent =
      formatBytes(data.disk_used) + " / " + formatBytes(data.disk_total);
    document.getElementById("load").textContent =
      data.load_1.toFixed(2) +
      " / " +
      data.load_5.toFixed(2) +
      " / " +
      data.load_15.toFixed(2);
  } catch (e) {
    console.error("获取系统数据失败:", e);
  }
}

// SSE 实时网速
function connectRealtime() {
  const eventSource = new EventSource("/api/traffic/realtime");

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    document.getElementById("tx-speed").textContent = formatSpeed(
      data.tx_speed,
    );
    document.getElementById("rx-speed").textContent = formatSpeed(
      data.rx_speed,
    );
  };

  eventSource.onerror = () => {
    console.error("SSE 连接断开，5秒后重连...");
    eventSource.close();
    setTimeout(connectRealtime, 5000);
  };
}

// 延迟图表
let latencyChart = null;
let latencyData = null;
const latencyColors = [
  { border: "#f9b920", bg: "rgba(249, 185, 32, 0.1)" },
  { border: "#3fb950", bg: "rgba(63, 185, 80, 0.1)" },
  { border: "#58a6ff", bg: "rgba(88, 166, 255, 0.1)" },
  { border: "#a371f7", bg: "rgba(163, 113, 247, 0.1)" },
  { border: "#f85149", bg: "rgba(248, 81, 73, 0.1)" },
];

// 延迟查询参数
let latencyStartDate = null;
let latencyEndDate = null;

async function fetchLatency(start = null, end = null) {
  try {
    let url = "/api/latency";
    if (start && end) {
      url += `?start=${start}&end=${end}`;
    }
    const res = await fetch(url);
    latencyData = await res.json();

    // 显示粒度信息
    const granularityEl = document.getElementById("latency-granularity");
    if (granularityEl && latencyData.granularity) {
      granularityEl.textContent = `粒度: ${latencyData.granularity} 分钟`;
    }

    renderLatencyChart();
    renderLatencyStats();
  } catch (e) {
    console.error("获取延迟数据失败:", e);
  }
}

function renderLatencyChart() {
  if (!latencyData || !latencyData.targets) return;

  const datasets = [];
  const annotations = {};

  latencyData.targets.forEach((target, idx) => {
    const color = latencyColors[idx % latencyColors.length];
    const points = target.points || [];

    // 主数据线
    datasets.push({
      label: target.tag,
      data: points.map((p) => ({ x: p.ts * 1000, y: p.rtt_ms })),
      borderColor: color.border,
      backgroundColor: color.bg,
      fill: false,
      tension: 0.2,
      pointRadius: 0,
      borderWidth: 1.5,
    });

    // 平均值线
    if (target.stats && target.stats.avg > 0) {
      annotations[`avg-${idx}`] = {
        type: "line",
        yMin: target.stats.avg,
        yMax: target.stats.avg,
        borderColor: color.border,
        borderWidth: 1,
        borderDash: [5, 5],
        label: {
          display: true,
          content: `平均 ${target.stats.avg.toFixed(1)}`,
          position: "end",
          backgroundColor: color.border,
          color: "#0d1117",
          font: { size: 10 },
        },
      };
    }
  });

  // 获取所有时间戳作为 labels
  const allPoints = latencyData.targets.flatMap((t) => t.points || []);
  const labels = [...new Set(allPoints.map((p) => p.ts))].sort();

  if (latencyChart) {
    latencyChart.data.datasets = datasets;
    latencyChart.options.plugins.annotation = { annotations };
    latencyChart.update("none"); // 禁用动画，避免闪烁
  } else {
    const ctx = document.getElementById("latency-chart").getContext("2d");
    latencyChart = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            position: "top",
            labels: { color: "#8b949e", usePointStyle: true, boxWidth: 8 },
            onClick: (e, legendItem, legend) => {
              const idx = legendItem.datasetIndex;
              const meta = legend.chart.getDatasetMeta(idx);
              meta.hidden = !meta.hidden;
              legend.chart.update();
            },
          },
          tooltip: {
            callbacks: {
              title: (items) =>
                new Date(items[0].parsed.x).toLocaleString("zh-CN"),
              label: (item) => `${item.dataset.label}: ${item.parsed.y?.toFixed(2) || "-"} ms`,
            },
          },
          annotation: { annotations },
        },
        scales: {
          x: {
            type: "time",
            time: { unit: "hour", displayFormats: { hour: "HH:mm" } },
            grid: { display: false },
            ticks: { color: "#8b949e" },
          },
          y: {
            beginAtZero: true,
            grid: { color: "#30363d" },
            ticks: { color: "#8b949e" },
            title: { display: true, text: "ms", color: "#8b949e" },
          },
        },
      },
    });
  }
}

function renderLatencyStats() {
  const container = document.getElementById("latency-stats");
  if (!container || !latencyData || !latencyData.targets) return;

  container.innerHTML = latencyData.targets
    .map((t, idx) => {
      const color = latencyColors[idx % latencyColors.length].border;
      const stats = t.stats || {};
      return `
      <div class="latency-stat-item" style="border-left: 3px solid ${color}; padding-left: 8px; margin-bottom: 8px;">
        <div class="stat-tag">${t.tag}</div>
        <div class="stat-values">
          <span>平均: <strong>${stats.avg?.toFixed(1) || "-"}</strong>ms</span>
          <span>最小: <strong style="color:#3fb950">${stats.min?.toFixed(1) || "-"}</strong>ms</span>
          <span>最大: <strong style="color:#f85149">${stats.max?.toFixed(1) || "-"}</strong>ms</span>
        </div>
      </div>
    `;
    })
    .join("");
}

// 月度趋势图表
let trendChart = null;
let trendData = null;
let trendView = "detail"; // detail | total

async function fetchMonthlyTrend() {
  try {
    const res = await fetch("/api/traffic/monthly");
    trendData = await res.json();

    // 空数据保护
    if (!trendData || !Array.isArray(trendData)) {
      console.warn("月度趋势数据为空");
      return;
    }

    renderTrendChart();
  } catch (e) {
    console.error("获取月度趋势失败:", e);
  }
}

function renderTrendChart() {
  if (!trendData) return;

  const labels = trendData.map((d) => {
    const parts = d.month.split("-");
    return parts[1] + "月";
  });
  const totalLabels = trendData.map((d) => d.total_gb);

  let datasets = [];
  let legendHtml = "";

  if (trendView === "detail") {
    // 详细视图：4根柱子
    datasets = [
      {
        label: "Snell 上传",
        data: trendData.map((d) => d.snell_tx / 1024 / 1024 / 1024),
        backgroundColor: "#3b82f6",
        borderRadius: 4,
      },
      {
        label: "Snell 下载",
        data: trendData.map((d) => d.snell_rx / 1024 / 1024 / 1024),
        backgroundColor: "#60a5fa",
        borderRadius: 4,
      },
      {
        label: "VLESS 上传",
        data: trendData.map((d) => d.vless_tx / 1024 / 1024 / 1024),
        backgroundColor: "#a855f7",
        borderRadius: 4,
      },
      {
        label: "VLESS 下载",
        data: trendData.map((d) => d.vless_rx / 1024 / 1024 / 1024),
        backgroundColor: "#c084fc",
        borderRadius: 4,
      },
    ];
    legendHtml = `
      <span class="legend-item"><span class="dot" style="background:#3b82f6"></span>Snell 上传</span>
      <span class="legend-item"><span class="dot" style="background:#60a5fa"></span>Snell 下载</span>
      <span class="legend-item"><span class="dot" style="background:#a855f7"></span>VLESS 上传</span>
      <span class="legend-item"><span class="dot" style="background:#c084fc"></span>VLESS 下载</span>
    `;
  } else {
    // 总计视图：1根柱子
    datasets = [
      {
        label: "总计",
        data: trendData.map((d) => d.total / 1024 / 1024 / 1024),
        backgroundColor: "#22c55e",
        borderRadius: 4,
      },
    ];
    legendHtml = `<span class="legend-item"><span class="dot" style="background:#22c55e"></span>总计流量</span>`;
  }

  // 更新图例
  document.getElementById("trend-legend").innerHTML = legendHtml;

  if (trendChart) {
    trendChart.data.labels = labels;
    trendChart.data.datasets = datasets;
    trendChart.update("none");
  } else {
    const ctx = document.getElementById("trend-chart").getContext("2d");
    trendChart = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(2)} GB`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: "#6e6e80",
              callback: function (value, index) {
                return [totalLabels[index], labels[index]];
              },
            },
          },
          y: {
            display: false,
            beginAtZero: true,
          },
        },
      },
    });
  }
}

// 视图切换
function setupTrendToggle() {
  const detailBtn = document.getElementById("trend-detail");
  const totalBtn = document.getElementById("trend-total");

  if (detailBtn) {
    detailBtn.addEventListener("click", () => {
      trendView = "detail";
      detailBtn.classList.add("active");
      detailBtn.classList.remove("btn-secondary");
      totalBtn.classList.remove("active");
      totalBtn.classList.add("btn-secondary");
      renderTrendChart();
    });
  }

  if (totalBtn) {
    totalBtn.addEventListener("click", () => {
      trendView = "total";
      totalBtn.classList.add("active");
      totalBtn.classList.remove("btn-secondary");
      detailBtn.classList.remove("active");
      detailBtn.classList.add("btn-secondary");
      renderTrendChart();
    });
  }
}


// 初始化
document.addEventListener("DOMContentLoaded", () => {
  fetchStats();
  fetchSystem();
  fetchLatency();
  fetchMonthlyTrend();
  connectRealtime();
  setupTrendToggle();

  // 延迟监控时间选择器
  const latencyStartEl = document.getElementById("latency-start");
  const latencyEndEl = document.getElementById("latency-end");
  const latencyQueryBtn = document.getElementById("latency-query");
  const latencyResetBtn = document.getElementById("latency-reset");

  // 设置默认日期（今天）
  const today = new Date().toISOString().split("T")[0];
  if (latencyEndEl) latencyEndEl.value = today;

  // 查询按钮
  if (latencyQueryBtn) {
    latencyQueryBtn.addEventListener("click", () => {
      const start = latencyStartEl?.value;
      const end = latencyEndEl?.value;
      if (start && end) {
        latencyStartDate = start;
        latencyEndDate = end;
        fetchLatency(start, end);
      } else {
        alert("请选择开始和结束日期");
      }
    });
  }

  // 重置按钮
  if (latencyResetBtn) {
    latencyResetBtn.addEventListener("click", () => {
      if (latencyStartEl) latencyStartEl.value = "";
      if (latencyEndEl) latencyEndEl.value = today;
      latencyStartDate = null;
      latencyEndDate = null;
      fetchLatency();
    });
  }

  // 定时刷新
  setInterval(fetchStats, 60000); // 1 分钟
  setInterval(fetchSystem, 5000); // 5 秒
  setInterval(() => {
    // 延迟监控：如果有自定义时间范围则用该范围刷新，否则用默认
    if (latencyStartDate && latencyEndDate) {
      fetchLatency(latencyStartDate, latencyEndDate);
    } else {
      fetchLatency();
    }
  }, 60000); // 1 分钟
  setInterval(fetchMonthlyTrend, 3600000); // 1 小时
});
