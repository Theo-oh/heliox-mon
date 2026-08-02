// 延迟目标的分类色板。chart.js / stats.js 都要按同一顺序给目标上色，
// 抽成叶子模块而不是让两者互相 import，避免子模块之间产生方向不明的依赖。

import { palette } from "../../core/theme.js";

// 首色是设计稿指定的延迟序列色（--accent-blue），其余为多目标增补；
// 末两色不在语义 token 里，属纯分类用途。
// ⚠️ 必须在渲染时调用，不能在模块顶层求值——主题切换后要拿到新色。
export function latencyPalette() {
  const pal = palette();
  return [pal.info, pal.ok, pal.warn, pal.purple, "#64d2ff", "#ff375f"];
}

/** @param {string[]} colors @param {number} idx */
export function targetColor(colors, idx) {
  return colors[idx % colors.length];
}
