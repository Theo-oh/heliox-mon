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
    document.getElementById("month-tx").textContent =
      "↑ " + formatBytes(data.this_month.tx);
    document.getElementById("month-rx").textContent =
      "↓ " + formatBytes(data.this_month.rx);
    document.getElementById("last-month-tx").textContent =
      "↑ " + formatBytes(data.last_month.tx);
    document.getElementById("last-month-rx").textContent =
      "↓ " + formatBytes(data.last_month.rx);

    // 配额
    const usedGB = Math.round(
      (data.this_month.tx + data.this_month.rx) / 1024 / 1024 / 1024,
    );
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
  } catch (e) {
    console.error("获取统计数据失败:", e);
  }
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

async function fetchLatency() {
  try {
    const res = await fetch("/api/latency");
    latencyData = await res.json();
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
    latencyChart.update();
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

async function fetchMonthlyTrend() {
  try {
    const res = await fetch("/api/traffic/monthly");
    const data = await res.json();

    const labels = data.map((d) => d.month).reverse();
    const txData = data.map((d) => d.tx / 1024 / 1024 / 1024).reverse(); // GB
    const rxData = data.map((d) => d.rx / 1024 / 1024 / 1024).reverse();

    if (trendChart) {
      trendChart.data.labels = labels;
      trendChart.data.datasets[0].data = txData;
      trendChart.data.datasets[1].data = rxData;
      trendChart.update();
    } else {
      const ctx = document.getElementById("trend-chart").getContext("2d");
      trendChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: "上行 (GB)",
              data: txData,
              backgroundColor: "#3fb950",
            },
            {
              label: "下行 (GB)",
              data: rxData,
              backgroundColor: "#58a6ff",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "top",
              labels: { color: "#8b949e" },
            },
          },
          scales: {
            x: {
              stacked: true,
              grid: { display: false },
              ticks: { color: "#8b949e" },
            },
            y: {
              stacked: true,
              grid: { color: "#30363d" },
              ticks: { color: "#8b949e" },
            },
          },
        },
      });
    }
  } catch (e) {
    console.error("获取月度趋势失败:", e);
  }
}

// 初始化
document.addEventListener("DOMContentLoaded", () => {
  fetchStats();
  fetchSystem();
  fetchLatency();
  fetchMonthlyTrend();
  connectRealtime();

  // 定时刷新
  setInterval(fetchStats, 60000); // 1 分钟
  setInterval(fetchSystem, 5000); // 5 秒
  setInterval(fetchLatency, 60000); // 1 分钟
  setInterval(fetchMonthlyTrend, 3600000); // 1 小时
});
