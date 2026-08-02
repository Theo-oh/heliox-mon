// 主题切换。图表模块通过 onThemeChange 注册重绘回调，而不是让这里硬编码一份
// 调用列表——那份列表历史上漏掉过趋势图，切主题后颜色要等下次数据刷新才纠正。

import { $ } from "./dom.js";

const themeStorageKey = "heliox-theme";

/** @type {Set<(isLight: boolean) => void>} */
const redrawHandlers = new Set();

/**
 * 注册「主题变化时重绘」。返回注销函数。
 * @param {(isLight: boolean) => void} fn
 */
export function onThemeChange(fn) {
  redrawHandlers.add(fn);
  return () => redrawHandlers.delete(fn);
}

/** 读取 CSS 变量。颜色必须在渲染时现取，不能在模块顶层求值 */
/** @param {string} name */
export function getCssVar(name) {
  const root = document.body || document.documentElement;
  return getComputedStyle(root).getPropertyValue(name).trim();
}

export function isLight() {
  return document.body.classList.contains("theme-light");
}

/** @param {string} hex @param {number} alpha */
export function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return `rgba(0, 0, 0, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 全站语义色的唯一出口。各模块不再自己 getCssVar，也不再散写十六进制字面量。
 * ⚠️ 必须在 render 函数体内调用，不能在模块顶层求值——那样主题切换后拿到的是旧色。
 */
export function palette() {
  return {
    up: getCssVar("--speed-up") || "#b66cff", // 上行 / 上传 / TX
    down: getCssVar("--speed-down") || "#4dd4ff", // 下行 / 下载 / RX
    ok: getCssVar("--accent-green") || "#30d158",
    warn: getCssVar("--accent-orange") || "#ff9f0a",
    danger: getCssVar("--accent-red") || "#ff453a",
    info: getCssVar("--accent-blue") || "#0a84ff",
    purple: getCssVar("--accent-purple") || "#bf5af2",
    text: getCssVar("--text") || "#f5f5f7",
    muted: getCssVar("--muted") || "#86868b",
    axis: getCssVar("--axis-faint") || "#5c5c61",
    grid: getCssVar("--speed-grid") || "rgba(255, 255, 255, 0.08)",
    card: getCssVar("--card-bg"),
    border: getCssVar("--card-border"),
  };
}

/** Chart.js 与 ECharts 的 tooltip 配色一致，收在一处避免两边各写一份 */
export function tooltipColors() {
  const light = isLight();
  return {
    bg: light ? "rgba(255, 255, 255, 0.95)" : "rgba(28, 28, 30, 0.95)",
    text: light ? "#1c1c1e" : "#f5f5f7",
    border: light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
    footer: light ? "#86868b" : "#8E8E93",
  };
}

/** @param {string} theme */
export function applyTheme(theme) {
  const light = theme === "light";
  document.body.classList.toggle("theme-light", light);
  const themeText = document.querySelector("#theme-toggle .theme-text");
  if (themeText) {
    themeText.textContent = light ? "浅色" : "深色";
  }
  // PWA 独立窗口的标题栏/状态栏取色于此，不同步会导致浅色主题下顶部仍是深色
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute("content", light ? "#f5f5f7" : "#0a0a0a");
  }
  for (const fn of redrawHandlers) {
    try {
      fn(light);
    } catch (e) {
      console.error("主题重绘失败:", e);
    }
  }
}

/** 必须在各模块 init 之前调用：先落 theme-light，图表建图时才拿得到正确色值 */
export function initTheme() {
  const stored = localStorage.getItem(themeStorageKey);
  // 未手动选择过时跟随系统偏好，默认深色
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(stored || (prefersLight ? "light" : "dark"));

  const toggleBtn = $("theme-toggle");
  if (!toggleBtn) return;
  toggleBtn.addEventListener("click", () => {
    const next = isLight() ? "dark" : "light";
    localStorage.setItem(themeStorageKey, next);
    applyTheme(next);
  });
}
