// Heliox Monitor 前端入口。
// module script 天然 defer，执行时 DOM 已解析完毕，不需要再包一层 DOMContentLoaded。

import { startStream } from "./core/stream.js";
import { initTheme } from "./core/theme.js";
import { initLatency, refreshLatency } from "./modules/latency.js";
import { initNotify } from "./modules/notify.js";
import { initRealtime } from "./modules/realtime.js";
import { initSystem, refreshSystem } from "./modules/system.js";
import { initTraffic, refreshTraffic } from "./modules/traffic.js";
import { initTrend, refreshMonthlyTrend, refreshTrend } from "./modules/trend.js";

// 模块图是「全或无」的：任何一个文件 404 或语法出错，整个入口都不会执行，
// 页面停在初始骨架且界面上毫无提示。这行日志就是「模块跑起来了」的信标。
console.info("heliox ui booted");

initTheme(); // 必须最先：先落 theme-light，图表建图时才拿得到正确色值

initSystem();
initRealtime();
initTraffic();
initTrend();
initLatency();
initNotify();

startStream(); // 订阅全部注册完再开 SSE
startSchedules();

function startSchedules() {
  // 定时刷新（系统状态由 SSE 的 system 事件推送，不再单独轮询）
  setInterval(() => {
    refreshTraffic();
    refreshTrend();
  }, 60000); // 1 分钟
  setInterval(refreshLatency, 60000); // 1 分钟
  setInterval(refreshMonthlyTrend, 3600000); // 1 小时

  // 页面休眠恢复机制（Chrome 后台标签页休眠后恢复刷新）
  let lastActiveTime = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const now = Date.now();
      // 如果离开超过 30 秒，立即刷新所有数据
      if (now - lastActiveTime > 30000) {
        refreshTraffic();
        refreshTrend();
        refreshSystem();
        refreshMonthlyTrend();
        refreshLatency();
        // SSE 会自动重连，无需手动处理
      }
      lastActiveTime = now;
    } else {
      lastActiveTime = Date.now();
    }
  });
}
