// 极小的 DOM 辅助层：只收敛最高频的几个动作，不做元素缓存也不做模板 DSL。
// 卡片容器普遍会被 innerHTML 整体重建，缓存子节点引用只会拿到失效的旧元素。

/** @param {string} id */
export const $ = (id) => document.getElementById(id);

/** @param {string} id @param {string|number} text */
export function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = String(text);
}

/** @param {string} id @param {string} html */
export function setHtml(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

/** @param {string} id @param {string} type @param {(e: any) => void} fn */
export function on(id, type, fn) {
  const el = $(id);
  if (el) el.addEventListener(type, fn);
  return el;
}

// 转义用户/配置可控字符串，避免拼接进 innerHTML 时产生注入
/** @param {any} value */
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
