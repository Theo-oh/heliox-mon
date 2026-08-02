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
