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
let activeTags = new Set(); // 选中的运营商标签
let filtersInitialized = false;
const themeStorageKey = "heliox-theme";

function formatDateValue(date) {
  return date.toISOString().split("T")[0];
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("theme-light", isLight);
  const themeText = document.querySelector("#theme-toggle .theme-text");
  if (themeText) {
    themeText.textContent = isLight ? "浅色" : "深色";
  }
  renderLatencyChart();
}

function initThemeToggle() {
  const stored = localStorage.getItem(themeStorageKey);
  const preferred = stored || "dark";
  applyTheme(preferred);

  const toggleBtn = document.getElementById("theme-toggle");
  if (!toggleBtn) return;
  toggleBtn.addEventListener("click", () => {
    const next = document.body.classList.contains("theme-light") ? "dark" : "light";
    localStorage.setItem(themeStorageKey, next);
    applyTheme(next);
  });
}

function normalizeRange(startVal, endVal) {
  let start = startVal ? String(startVal).trim() : "";
  let end = endVal ? String(endVal).trim() : "";

  if (!start && !end) {
    return { start: null, end: null };
  }

  if (!start && end) start = end;
  if (start && !end) end = start;

  if (start && end && start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  return { start, end };
}

function shiftDateValue(dateStr, offsetDays) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + offsetDays);
  return formatDateValue(date);
}

async function fetchLatency(start = null, end = null) {
  try {
    let url = "/api/latency";
    const range = normalizeRange(start, end);
    if (range.start && range.end) {
      url += `?start=${range.start}&end=${range.end}`;
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
    targets.forEach((t, idx) => {
        // 默认全选
        activeTags.add(t.tag);

        const label = document.createElement("label");
        label.className = "filter-pill";
        const dot = document.createElement("span");
        dot.className = "latency-target-dot";
        dot.style.background = latencyColors[idx % latencyColors.length].border;
        
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
            renderLatencyStats();
        });

        label.appendChild(input);
        label.appendChild(dot);
        label.appendChild(document.createTextNode(" " + t.tag));
        container.appendChild(label);
    });
}

function renderLatencyChart() {
  if (!latencyData || !latencyData.targets) return;

  const showMax = document.getElementById("show-max")?.checked ?? true;
  const showAvg = document.getElementById("show-avg")?.checked ?? true;

  const chartEl = document.getElementById("latency-chart");
  if (!chartEl || typeof echarts === "undefined") return;

  if (!latencyChart) {
    latencyChart = echarts.init(chartEl, null, { renderer: "canvas" });
    window.addEventListener("resize", () => {
      if (latencyChart) latencyChart.resize();
    });
  }

  const textColor = getCssVar("--text");
  const mutedColor = getCssVar("--muted");
  const borderColor = getCssVar("--card-border");
  const tooltipBg = getCssVar("--card-bg");
  const isLight = document.body.classList.contains("theme-light");
  const gridLine = isLight ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.06)";
  const zoomBg = isLight ? "rgba(0, 0, 0, 0.08)" : "rgba(0, 0, 0, 0.2)";
  const zoomFill = isLight ? "rgba(10, 132, 255, 0.25)" : "rgba(10, 132, 255, 0.2)";

  const series = latencyData.targets
    .filter((target) => activeTags.has(target.tag))
    .map((target, idx) => {
      const color = latencyColors[idx % latencyColors.length];
      const points = target.points || [];
      const data = points.map((p) => [p.ts * 1000, p.rtt_ms]);
      const avg = target.stats?.avg ?? 0;

      return {
        name: target.tag,
        type: "line",
        smooth: true,
        showSymbol: false,
        data,
        lineStyle: { color: color.border, width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: color.bg.replace("0.1", "0.35") },
            { offset: 1, color: "rgba(0,0,0,0)" },
          ]),
        },
        emphasis: { focus: "series" },
        markPoint: showMax
          ? {
              symbolSize: 46,
              itemStyle: { color: color.border },
              label: { color: "#000", fontWeight: "600", formatter: "{b}" },
              data: [
                { type: "max", name: "MAX" },
                { type: "min", name: "MIN" },
              ],
            }
          : undefined,
        markLine:
          showAvg && avg > 0
            ? {
                symbol: "none",
                lineStyle: { color: color.border, width: 1, type: "dashed" },
                label: {
                  color: textColor,
                  formatter: `${target.tag} 平均 ${avg.toFixed(1)}ms`,
                  position: "end",
                },
                data: [{ yAxis: avg }],
              }
            : undefined,
      };
    });

  const prevZoom = latencyChart.getOption().dataZoom?.[1];
  const zoomStart = prevZoom?.start ?? 0;
  const zoomEnd = prevZoom?.end ?? 100;

  const option = {
    animation: false,
    grid: { left: 50, right: 24, top: 24, bottom: 54, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: tooltipBg,
      borderColor: borderColor,
      textStyle: { color: textColor },
      axisPointer: { type: "cross", label: { color: textColor } },
      formatter: (params) => {
        const time = new Date(params[0].value[0]).toLocaleString("zh-CN");
        const rows = params
          .map(
            (p) =>
              `<span style=\"display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:50%;background:${p.color}\"></span>${p.seriesName}: ${p.value[1].toFixed(1)} ms`,
          )
          .join("<br/>");
        return `${time}<br/>${rows}`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: borderColor } },
      axisLabel: { color: mutedColor },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      axisLine: { lineStyle: { color: borderColor } },
      axisLabel: { color: mutedColor, formatter: "{value} ms" },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        start: zoomStart,
        end: zoomEnd,
      },
      {
        type: "slider",
        xAxisIndex: 0,
        height: 26,
        bottom: 10,
        start: zoomStart,
        end: zoomEnd,
        borderColor: borderColor,
        backgroundColor: zoomBg,
        fillerColor: zoomFill,
        handleSize: "120%",
        handleStyle: {
          color: "#0a84ff",
          borderColor: borderColor,
        },
        textStyle: { color: mutedColor },
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
        style: { text: "暂无数据", fill: mutedColor, fontSize: 14 },
      },
    ];
  }

  latencyChart.setOption(option, true);
}

function renderLatencyStats() {
  const container = document.getElementById("latency-stats");
  if (!container || !latencyData || !latencyData.targets) return;
  let totalCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  const targetCards = latencyData.targets
    .filter((t) => activeTags.has(t.tag))
    .map((t, idx) => {
      const stats = t.stats || {};
      const count = stats.count ?? (t.points ? t.points.length : 0);
      if (count && stats.avg != null) {
        sum += stats.avg * count;
        totalCount += count;
      }
      if (stats.min != null && stats.min < min) min = stats.min;
      if (stats.max != null && stats.max > max) max = stats.max;

      const color = latencyColors[idx % latencyColors.length].border;
      return `
        <div class="latency-target-card">
          <div class="latency-target-header">
            <span class="latency-target-dot" style="background:${color}"></span>
            <span>${t.tag}</span>
          </div>
          <div class="latency-target-values">
            <span>均值 <strong>${stats.avg?.toFixed(1) ?? "-"}</strong>ms</span>
            <span>最小 <strong>${stats.min?.toFixed(1) ?? "-"}</strong>ms</span>
            <span>最大 <strong>${stats.max?.toFixed(1) ?? "-"}</strong>ms</span>
          </div>
        </div>
      `;
    })
    .join("");

  const hasData = totalCount > 0;
  const avg = hasData ? sum / totalCount : 0;
  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 0;
  const avgText = hasData ? avg.toFixed(1) : "-";
  const minText = hasData ? min.toFixed(1) : "-";
  const maxText = hasData ? max.toFixed(1) : "-";

  container.innerHTML = `
    <div class="latency-summary">
      <div class="latency-metric">
        <span class="label">平均延迟</span>
        <span class="value">${avgText}<small>ms</small></span>
      </div>
      <div class="latency-metric">
        <span class="label">最小延迟</span>
        <span class="value">${minText}<small>ms</small></span>
      </div>
      <div class="latency-metric">
        <span class="label">最大延迟</span>
        <span class="value">${maxText}<small>ms</small></span>
      </div>
    </div>
    <div class="latency-targets">${targetCards}</div>
  `;
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
  fetchMonthlyTrend();
  connectRealtime();
  setupTrendToggle();
  initThemeToggle();

  // 延迟监控时间选择器
  const latencyEndEl = document.getElementById("latency-end");
  const latencyStartEl = document.getElementById("latency-start");
  const latencyQueryBtn = document.getElementById("latency-query");
  const latencyResetBtn = document.getElementById("latency-reset");
  const datePrevBtn = document.getElementById("date-prev");
  const dateNextBtn = document.getElementById("date-next");

  // 设置默认日期（今天）
  const today = formatDateValue(new Date());
  if (latencyEndEl) latencyEndEl.value = today;
  if (latencyStartEl) latencyStartEl.value = today;
  latencyStartDate = today;
  latencyEndDate = today;

  fetchLatency(latencyStartDate, latencyEndDate);

  // 查询按钮
  if (latencyQueryBtn) {
    latencyQueryBtn.addEventListener("click", () => {
      const { start, end } = normalizeRange(
        latencyStartEl?.value,
        latencyEndEl?.value,
      );

      if (!start && !end) {
        latencyStartDate = null;
        latencyEndDate = null;
        fetchLatency();
        return;
      }

      if (latencyStartEl) latencyStartEl.value = start;
      if (latencyEndEl) latencyEndEl.value = end;
      latencyStartDate = start;
      latencyEndDate = end;
      fetchLatency(start, end);
    });
  }
  
  // 前一天/后一天
  if (datePrevBtn && latencyEndEl) {
      datePrevBtn.addEventListener("click", () => {
          const { start, end } = normalizeRange(
            latencyStartEl?.value,
            latencyEndEl?.value,
          );
          const baseStart = start || today;
          const baseEnd = end || today;
          const newStart = shiftDateValue(baseStart, -1);
          const newEnd = shiftDateValue(baseEnd, -1);

          if (latencyStartEl) latencyStartEl.value = newStart;
          if (latencyEndEl) latencyEndEl.value = newEnd;
          latencyStartDate = newStart;
          latencyEndDate = newEnd;
          fetchLatency(newStart, newEnd);
      });
  }
  
  if (dateNextBtn && latencyEndEl) {
      dateNextBtn.addEventListener("click", () => {
          const { start, end } = normalizeRange(
            latencyStartEl?.value,
            latencyEndEl?.value,
          );
          const baseStart = start || today;
          const baseEnd = end || today;
          const newStart = shiftDateValue(baseStart, 1);
          const newEnd = shiftDateValue(baseEnd, 1);
          if (newEnd > today) return;

          if (latencyStartEl) latencyStartEl.value = newStart;
          if (latencyEndEl) latencyEndEl.value = newEnd;
          latencyStartDate = newStart;
          latencyEndDate = newEnd;
          fetchLatency(newStart, newEnd);
      });
  }
  
  // 显示选项事件监听
  document.getElementById("show-max")?.addEventListener("change", renderLatencyChart);
  document.getElementById("show-avg")?.addEventListener("change", renderLatencyChart);

  // 重置按钮
  if (latencyResetBtn) {
    latencyResetBtn.addEventListener("click", () => {
      if (latencyStartEl) latencyStartEl.value = today;
      if (latencyEndEl) latencyEndEl.value = today;
      latencyStartDate = today;
      latencyEndDate = today;
      fetchLatency(today, today);
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
