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

    document.title = data.server_name;
    const badge = document.getElementById("server-name"); 
    if(badge) badge.textContent = data.server_name;
    document.getElementById("current-time").textContent = data.current_time;

    // 流量数据
    document.getElementById("today-total").parentElement.innerHTML = `
        <div class="stats-group-up"><span class="stat-up">↑ ${formatBytes(data.today.tx)}</span></div>
        <div class="stats-group-down"><span class="stat-down">↓ ${formatBytes(data.today.rx)}</span></div>
        <div class="stats-group-total"><span class="stat-total">⇅ ${formatBytes(data.today.tx + data.today.rx)}</span></div>
    `;

    document.getElementById("yesterday-total").parentElement.innerHTML = `
        <div class="stats-group-up"><span class="stat-up">↑ ${formatBytes(data.yesterday.tx)}</span></div>
        <div class="stats-group-down"><span class="stat-down">↓ ${formatBytes(data.yesterday.rx)}</span></div>
        <div class="stats-group-total"><span class="stat-total">⇅ ${formatBytes(data.yesterday.tx + data.yesterday.rx)}</span></div>
    `;

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
      if (todayEl)
        todayEl.innerHTML = '<div class="port-no-data">暂无端口流量数据</div>';
      return;
    }

    // 检查 iptables 规则状态
    if (data.iptables_ok === false) {
      const todayEl = document.getElementById("port-traffic-today");
      if (todayEl) {
        todayEl.innerHTML =
          '<div class="port-warning">⚠️ iptables 规则未完整配置（TCP/UDP），请运行 setup-iptables.sh</div>';
      }
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
      // 使用 Grid 布局：第一行名称，第二行三组数据
      return `
      <div class="port-item ${cssClass}">
        <span class="port-name">${p.name.toLowerCase()}</span>
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
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = ports
    .map((p) => {
      const d = p.this_month;
      const gb = (d.total / 1024 / 1024 / 1024).toFixed(2);
      return `
      <div class="month-item">
        <div class="port-name">${p.name.toLowerCase()}</div>
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
  { border: "#FFD60A", bg: "rgba(255, 214, 10, 0.1)" }, // Yellow
  { border: "#30D158", bg: "rgba(48, 209, 88, 0.1)" }, // Green
  { border: "#0A84FF", bg: "rgba(10, 132, 255, 0.1)" }, // Blue
  { border: "#BF5AF2", bg: "rgba(191, 90, 242, 0.1)" }, // Purple
  { border: "#FF453A", bg: "rgba(255, 69, 58, 0.1)" }, // Red
];

// 延迟查询参数
let latencyStartDate = null;
let latencyEndDate = null;
let timeRangeMinutes = 1440; // 默认24小时
let activeTags = new Set(); // 选中的运营商标签
let filtersInitialized = false;

async function fetchLatency(start = null, end = null) {
  try {
    let url = "/api/latency";
    // 如果没有指定日期，默认使用今日
    if (!start && !end) {
       const today = new Date().toISOString().split("T")[0];
       end = today; 
       // start 默认为空，后端会自动处理为 end 的0点
    }
    
    if (end) {
        url += `?end=${end}`;
        if (start) url += `&start=${start}`;
    }

    const res = await fetch(url);
    latencyData = await res.json();

    // 显示粒度信息
    const granularityEl = document.getElementById("latency-granularity");
    if (granularityEl && latencyData.granularity) {
      granularityEl.textContent = `粒度: ${latencyData.granularity} 分钟`;
    }

    // 初始化过滤器 (仅一次)
    if (!filtersInitialized && latencyData.targets) {
        renderFilterCheckboxes(latencyData.targets);
        filtersInitialized = true;
    }

    renderLatencyChart();
    renderLatencyStats();
  } catch (e) {
    console.error("获取延迟数据失败:", e);
  }
}

function renderFilterCheckboxes(targets) {
    const container = document.getElementById("target-filters");
    if (!container) return;
    
    container.innerHTML = "";
    targets.forEach(t => {
        // 默认全选
        activeTags.add(t.tag);

        const label = document.createElement("label");
        label.className = "filter-pill";
        
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.dataset.tag = t.tag;
        
        input.addEventListener("change", (e) => {
            if (e.target.checked) {
                activeTags.add(t.tag);
            } else {
                activeTags.delete(t.tag);
            }
            renderLatencyChart();
        });

        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + t.tag));
        container.appendChild(label);
    });
}

function renderLatencyChart() {
  if (!latencyData || !latencyData.targets) return;

  const showMax = document.getElementById("show-max")?.checked ?? true;
  const showAvg = document.getElementById("show-avg")?.checked ?? true;

  const datasets = [];
  const annotations = {};

  latencyData.targets.forEach((target, idx) => {
    // 过滤未选中的标签
    if (!activeTags.has(target.tag)) return;

    const color = latencyColors[idx % latencyColors.length];
    const points = target.points || [];

    // 过滤数据（根据时间滑块）
    let filteredPoints = points;
    if (timeRangeMinutes < 1440 && points.length > 0) {
        const lastTs = points[points.length - 1].ts;
        const startTs = lastTs - (timeRangeMinutes * 60);
        filteredPoints = points.filter(p => p.ts >= startTs);
    }
    
    // 找出极值点
    let maxPoint = null, minPoint = null;
    let maxVal = -Infinity, minVal = Infinity;
    
    if (showMax) {
        filteredPoints.forEach(p => {
            if(p.rtt_ms > maxVal) { maxVal = p.rtt_ms; maxPoint = p; }
            if(p.rtt_ms < minVal) { minVal = p.rtt_ms; minPoint = p; }
        });
    }

    const dataPoints = filteredPoints.map(p => ({ x: p.ts * 1000, y: p.rtt_ms }));
    
    // Point Styles (Bubble for Max/Min)
    const pointRadiuses = filteredPoints.map(p => (p === maxPoint || p === minPoint ? 6 : 0));
    const pointColors = filteredPoints.map(p => color.border);

    datasets.push({
      label: target.tag,
      data: dataPoints,
      borderColor: color.border,
      backgroundColor: color.bg,
      borderWidth: 1.5,
      pointRadius: pointRadiuses,
      pointBackgroundColor: pointColors,
      pointHoverRadius: 6,
      tension: 0.2, // Smooth curves
    });

    // Annotations: Average Line
    if (showAvg && target.stats && target.stats.avg > 0) {
      annotations[`avg-${idx}`] = {
        type: "line",
        yMin: target.stats.avg,
        yMax: target.stats.avg,
        borderColor: color.border,
        borderWidth: 1,
        borderDash: [5, 5],
        label: {
          display: true,
          content: `${target.tag} Avg: ${target.stats.avg.toFixed(1)}`,
          position: "end",
          backgroundColor: color.border,
          color: "#000",
          font: { size: 10, weight: "bold" },
          yAdjust: -10 * idx, // Stagger labels so they don't overlap
        },
      };
    }
    
    // Annotations: Max/Min Labels (Simulated via Point Labels or just Tooltips? 
    // Usually standard tooltip is enough, but user asked for bubbles. 
    // ChartJS annotation plugin can do "point" annotations too, but let's stick to the pointRadius highlight + tooltip for now to avoid clutter.)
  });

  const ctx = document.getElementById("latency-chart").getContext("2d");

  if (latencyChart) {
    latencyChart.data.datasets = datasets;
    latencyChart.options.plugins.annotation.annotations = annotations;
    latencyChart.update("none");
  } else {
    latencyChart = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: 'x', intersect: false },
        plugins: {
          legend: {
            display: false, // Hidden because we have filters
          },
          tooltip: {
             callbacks: {
               title: (items) => new Date(items[0].parsed.x).toLocaleString("zh-CN"),
             }
          },
          annotation: { annotations },
        },
        scales: {
          x: {
            type: "time",
            time: { unit: "minute", displayFormats: { minute: "HH:mm" } },
            grid: { display: false, borderColor: "#30363d" },
            ticks: { color: "#8b949e", maxTicksLimit: 8 },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(255, 255, 255, 0.05)" },
            ticks: { color: "#8b949e" },
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
    // 详细视图：2根柱子（snell/vless），每根柱子堆叠上传下载
    datasets = [
      {
        label: "snell 下载",
        data: trendData.map((d) => d.snell_rx / 1024 / 1024 / 1024),
        backgroundColor: "#64D2FF", // Cyan
        borderRadius: { bottomLeft: 4, bottomRight: 4 },
        stack: "snell",
      },
      {
        label: "snell 上传",
        data: trendData.map((d) => d.snell_tx / 1024 / 1024 / 1024),
        backgroundColor: "#0A84FF", // Blue
        borderRadius: { topLeft: 4, topRight: 4 },
        stack: "snell",
      },
      {
        label: "vless 下载",
        data: trendData.map((d) => d.vless_rx / 1024 / 1024 / 1024),
        backgroundColor: "#DA8FFF", // Light Purple
        borderRadius: { bottomLeft: 4, bottomRight: 4 },
        stack: "vless",
      },
      {
        label: "vless 上传",
        data: trendData.map((d) => d.vless_tx / 1024 / 1024 / 1024),
        backgroundColor: "#BF5AF2", // Purple
        borderRadius: { topLeft: 4, topRight: 4 },
        stack: "vless",
      },
    ];
    legendHtml = `
      <span class="legend-item"><span class="dot" style="background:#0A84FF"></span>snell 上传</span>
      <span class="legend-item"><span class="dot" style="background:#64D2FF"></span>snell 下载</span>
      <span class="legend-item"><span class="dot" style="background:#BF5AF2"></span>vless 上传</span>
      <span class="legend-item"><span class="dot" style="background:#DA8FFF"></span>vless 下载</span>
    `;
  } else {
    // 总计视图：2根柱子（上传/下载）
    datasets = [
      {
        label: "上传",
        data: trendData.map((d) => d.total_tx / 1024 / 1024 / 1024),
        backgroundColor: "#30D158", // Green
        borderRadius: 4,
      },
      {
        label: "下载",
        data: trendData.map((d) => d.total_rx / 1024 / 1024 / 1024),
        backgroundColor: "#89F3B1", // Light Green
        borderRadius: 4,
      },
    ];
    legendHtml = `
      <span class="legend-item"><span class="dot" style="background:#30D158"></span>上传</span>
      <span class="legend-item"><span class="dot" style="background:#89F3B1"></span>下载</span>
    `;
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
  const latencyEndEl = document.getElementById("latency-end");
  const latencyQueryBtn = document.getElementById("latency-query");
  const latencyResetBtn = document.getElementById("latency-reset");
  const datePrevBtn = document.getElementById("date-prev");
  const dateNextBtn = document.getElementById("date-next");
  const timeSlider = document.getElementById("time-slider");
  const timeDisplay = document.getElementById("time-display");

  // 设置默认日期（今天）
  const today = new Date().toISOString().split("T")[0];
  if (latencyEndEl) latencyEndEl.value = today;
  latencyEndDate = today;

  // 查询按钮
  if (latencyQueryBtn) {
    latencyQueryBtn.addEventListener("click", () => {
      const end = latencyEndEl?.value;
      if (end) {
        latencyEndDate = end;
        fetchLatency(null, end);
      }
    });
  }
  
  // 前一天/后一天
  if (datePrevBtn && latencyEndEl) {
      datePrevBtn.addEventListener("click", () => {
          const curr = new Date(latencyEndEl.value);
          curr.setDate(curr.getDate() - 1);
          const newDate = curr.toISOString().split("T")[0];
          latencyEndEl.value = newDate;
          latencyEndDate = newDate;
          fetchLatency(null, newDate);
      });
  }
  
  if (dateNextBtn && latencyEndEl) {
      dateNextBtn.addEventListener("click", () => {
          const curr = new Date(latencyEndEl.value);
          curr.setDate(curr.getDate() + 1);
          const newDate = curr.toISOString().split("T")[0];
          // 不允许超过今天
          if (newDate > today) return;
          latencyEndEl.value = newDate;
          latencyEndDate = newDate;
          fetchLatency(null, newDate);
      });
  }
  
  // 时间滑块
  if (timeSlider && timeDisplay) {
      timeSlider.addEventListener("input", (e) => {
          const val = parseInt(e.target.value);
          timeRangeMinutes = val;
          if (val === 1440) {
              timeDisplay.textContent = "24h";
          } else {
              const h = Math.floor(val / 60);
              const m = val % 60;
              timeDisplay.textContent = (h > 0 ? `${h}h` : "") + (m > 0 ? `${m}m` : "");
              if (h===0 && m===0) timeDisplay.textContent = "0m";
          }
          // 重新渲染图表（不请求后端，前端过滤）
          renderLatencyChart();
      });
  }
  
  // 显示选项事件监听
  document.getElementById("show-max")?.addEventListener("change", renderLatencyChart);
  document.getElementById("show-avg")?.addEventListener("change", renderLatencyChart);

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
