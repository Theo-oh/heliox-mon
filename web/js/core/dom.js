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

/**
 * 弹层开合：点击触发器切换、点击外部或 Esc 关闭。通知铃铛与延迟「更多」共用。
 * 全局已有 `[hidden] { display:none !important }`，所以只切 hidden 即可。
 * @param {string} triggerId @param {string} popId
 * @param {(open: boolean) => void} [onToggle] 每次开合后的回调（如清空上次结果）
 * @returns {{ setOpen: (open: boolean) => void, isOpen: () => boolean } | null}
 */
export function bindPopover(triggerId, popId, onToggle) {
  const trigger = $(triggerId);
  const pop = $(popId);
  if (!trigger || !pop) return null;

  const setOpen = (open) => {
    pop.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    trigger.classList.toggle("is-open", open);
    if (onToggle) onToggle(open);
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(pop.hidden);
  });
  // 弹层内部的点击不能冒泡到 document，否则会被下面的「点外部关闭」立刻收掉
  pop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (!pop.hidden) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) setOpen(false);
  });

  return { setOpen, isOpen: () => !pop.hidden };
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
