// 三个图表库是 <script> 挂到 window 上的 UMD 产物，没有类型声明。
// 这里是它们进入模块系统的唯一入口：既让依赖关系写进各模块的 import 列表，
// 也把类型断言集中到一处，不用在每个图表模块里散写。

/** @type {any} */
const w = window;

if (!w.Chart) {
  console.error("Chart.js 未加载：检查 index.html 里 vendor 脚本的顺序");
}
if (!w.echarts) {
  console.error("ECharts 未加载：检查 index.html 里 vendor 脚本的顺序");
}

/** @type {any} */
export const Chart = w.Chart;
/** @type {any} */
export const echarts = w.echarts;
