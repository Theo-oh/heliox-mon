# 设计方案：实时网速 / 流量统计 / 历史趋势 / 延迟监控 重设计

> 状态：**已实现**（`refactor/frontend-esm` 分支四个 commit,e25c3cd / fca3354 / 6f0ef7c / fe325ff）。
> 本文保留为视觉规范存档：design token、统一上下行语义色、各卡片的尺寸与配色口径,
> 后续调整这四个模块时以此为准。
> 交付时的高保真 HTML 设计稿与截图未入库（设计工具产物,内容已全部落地为代码）。
>
> **口径差异**：本文写于前端 ESM 拆分之前,提到的 `web/app.js` 现已拆为
> `web/js/modules/{realtime,traffic,trend,latency/}.js`,`web/js/core/` 为横切能力。
> 函数名（`renderTrendChart` / `renderLatencyStats` 等）大多沿用,按模块目录查找即可。

## Overview

`hh-io/heliox-mon` 的 Web 仪表盘(`web/index.html` + `web/style.css` + `web/app.js`,go:embed 进二进制)。
本次重设计**保留「系统状态」模块不变**,重做其余四个模块:实时网速、流量统计、历史趋势、延迟监控。
目标是更高的信息密度(监控台风格)、统一的上下行语义色、更精简的控制栏。

## About the Design Files

原始交付含一份高保真 HTML 设计稿(图表是静态 SVG 路径、数据是截图里的真实样本值),未入库。
下文的数值与配色即从那份稿子提取的最终值,足以独立复现。

实现方式:**在现有前端环境里复刻这些设计** —— 即 `web/` 下的原生 HTML/CSS/JS + 已内嵌的
Chart.js(`web/vendor/chart.umd.min.js`、`chartjs-plugin-annotation.min.js`)与 ECharts(`web/vendor/echarts.min.js`)。
不要引入新框架、不要引 CDN(项目要求单文件部署、无外部依赖)。设计稿里的 SVG 只是形状参考,
实际由 Chart.js / ECharts 渲染。

## Fidelity

**High-fidelity(hifi)**。颜色、字号、字重、间距、圆角均为最终值,可直接落到 `style.css`。
文案为最终文案。请按像素复刻。

---

## Design Tokens

沿用 `web/style.css` 现有变量,**新增/改动**如下:

| 变量 | 现值 | 本次 |
| --- | --- | --- |
| `--bg` | `#0a0a0a` | 不变 |
| `--text` | `#f5f5f7` | 不变 |
| `--muted` | `#86868b` | 不变 |
| `--card-bg` | `rgba(28,28,30,0.7)` | 不变 |
| `--card-border` | `rgba(255,255,255,0.08)` | 不变 |
| `--item-bg` | `rgba(44,44,46,0.5)` | 不变 |
| `--speed-up` | `#b66cff` | **升级为全站「上行」语义色** |
| `--speed-down` | `#4dd4ff` | **升级为全站「下行」语义色** |
| `--accent-green` | `#30d158` | 正常状态 |
| `--accent-orange` | `#ff9f0a` | 警告 / 丢包 |
| `--accent-red` | `#ff453a` | 危险 / 峰值标注 |
| `--accent-blue` | `#0a84ff` | 延迟序列色、信息角标 |
| 弱化文字 | — | 新增 `#5c5c61`(轴标签、超小说明) |

**统一配色规则(重要,替换现状的三套配色):**
- 上行 / 上传 / TX = `#b66cff`
- 下行 / 下载 / RX = `#4dd4ff`
- 原「流量统计」的绿(`#30d158`)/蓝(`#0a84ff`)上下行配色、
  原「历史趋势」的 `#4F7DF7` / `#39D0C3` 全部废弃,改用上面两色。
- `#30d158` 之后只表示「健康/正常」,不再表示上行。

圆角:卡片 `16px`,卡内块 `12px`,胶囊 `999px`,分段控件外 `10px` / 内 `7px`,小角标 `6px`。
字号:区块标题 32/700(渐变文字,沿用现有 `.section-title`);卡内标签 13/400 muted;
主数值 30–52/700 `font-variant-numeric: tabular-nums`;单位 11–15/400–600 muted;
指标条标签 11/400 muted + 值 16–18/600–700;轴标签 10/400 `#5c5c61`。
所有数字一律 `font-variant-numeric: tabular-nums`。
所有指标条分栏、胶囊、轴标签一律 `white-space: nowrap`(中文与单位不得断行)。

---

## Screens / Views

页面结构不变:`.wrapper`(max-width 1100,padding 40,radius 24)内依次为页眉、系统状态、
实时网速、流量统计、历史趋势、延迟监控。区块间距 48px(原 60px)。

**区块标题行改为 flex 一行**:左侧 32px 渐变标题,右侧同行放该模块的控件/元信息
(`align-items:flex-end; justify-content:space-between; margin-bottom:18px`)。
标题元素需 `white-space:nowrap; padding-right:14px`(渐变文字 `background-clip:text` 会裁掉末字)。

### 0. 页眉 / 系统状态 —— 不改

保持 `web/index.html` 与 `style.css` 现状。唯一注意:`.stat-bar-fill` 的 `--stat-bar` 保持 `#b66cff`,
与新的上行语义色一致,无需改动。

### 1. 实时网速

**标题行右侧**:两枚 11px 胶囊 —— `● LIVE · 1s`(绿点 `#30d158`,2s 呼吸动画)、`窗口 60s`。

**卡片**(`--card-bg`,padding `20px 22px 18px`),自上而下三段:

1. **实时读数行**(flex,gap 28px)
   - `↑ 上行` 13/600 `#b66cff` + 数值 34/700 `#b66cff` + 单位 13/600 muted
   - 1px 竖分隔线 `rgba(255,255,255,0.08)`,高 30px
   - `↓ 下行` 同上,色 `#4dd4ff`
   - 右侧 `margin-left:auto`:`合计 49.4 KB/s`、`峰值 228.4 KB/s`(12/400 muted,值 600 `--text`)
2. **镜像面积图**,高 190px。中轴 = 0,**上行向上、下行向下**(取代原来两条线叠在一起)。
   - 上行:线 `#b66cff` 2px,填充 `#b66cff` 0.40 → 0.02 由上至下渐变
   - 下行:线 `#4dd4ff` 2px,填充 `#4dd4ff` 0.02 → 0.40(由上至下)
   - 中轴实线 `rgba(255,255,255,0.18)`;上下各一条虚线网格 `rgba(255,255,255,0.05)` `3 5`
   - 右侧留 58–62px 轴区:`250 KB/s` / `0` / `250 KB/s`(10px `#5c5c61`,0 用 muted)
   - 左上角 `上行 ↑`、左下角 `下行 ↓`(10/600,对应色)
   - X 轴下方一行:`-60s / -45s / -30s / -15s / 现在`
   - Chart.js 实现建议:一个 `line` 图,下行数据取负值,`y.ticks.callback` 取绝对值格式化。
3. **指标条**(顶部 1px 分隔线,padding-top 14px),`grid-template-columns: repeat(auto-fit, minmax(150px,1fr))`,
   每栏左侧 1px 分隔线(首栏无):
   `60s 上行均值 22.0 KB/s`(紫)、`60s 下行均值 47.1 KB/s`(青)、`上行峰值 228.4 KB/s`、
   `下行峰值 195.2 KB/s`、`窗口累计 4.15 MB`。标签 11px muted,值 16/600。

### 2. 流量统计

**标题行右侧**:`计费 仅出站 (TX)`、`重置日 12 号 · 剩余 10 天`(11px 胶囊)。

**两卡并排**:`grid-template-columns: repeat(auto-fit, minmax(470px,1fr)); gap:16px`
(宽度不足自动上下堆叠 —— 这是刻意的,470px 以下表格列会挤到换行)。

**左卡「本月总流量」**(flex column,gap 18px):
- 头行:`本月总流量` 13px muted / 右 `2026-07-12 起` 11px muted
- 主数值 `645.73` 52/700 letter-spacing -2px + `GB` 18/600 muted
- 配额:标签行 `计费用量 292 / 5000 GB` 与右侧 `5.8%`(12px,值 600);
  轨道高 10px radius 999,底 `rgba(0,0,0,0.35)` + 1px `rgba(255,255,255,0.05)`;
  填充 `linear-gradient(90deg,#b66cff,#4dd4ff)`;
  80/90/95% 处 1px 白色刻度 `rgba(255,255,255,0.35)`;下方 `0` 与 `80 · 90 · 95 预警`(10px `#5c5c61`)
- 底部三栏(顶部 1px 分隔线,`repeat(auto-fit,minmax(120px,1fr))`):
  `剩余额度 4708 GB`、`日均消耗 29.35 GB`、`周期末预估 585 GB`(预估值用 `#30d158`,
  超限时应转 `#ff9f0a` / `#ff453a`)

**右卡「按协议明细」**(取代原来的今日/昨日两张卡):
- 头行:`按协议明细` 13px muted / 右侧图例 `↑ 上行`(紫)`↓ 下行`(青)11px
- 表格 grid:`56px 1fr 1fr minmax(120px,1.2fr)`,`gap: 0 12px`,四行共用同一列定义
  - 表头 10px `#5c5c61` 大写字距 0.6px,底 1px 分隔线:`协议 / 今日 / 昨日 / 本月累计`
  - `snell`、`vless` 行:协议名 13/600;今日、昨日列各两行 12px `↑ 值`(紫)/ `↓ 值`(青),line-height 1.6;
    本月列右对齐 17/600 + 单位 11px muted,下方 4px 占比条(snell 99.8% 紫 / vless 0.2% 青,右对齐)
  - `总计` 行:协议名 muted;今日/昨日列三行(↑ / ↓ / `⇅ 合计` muted);
    本月列 22/700 `645.73 GB`
- 所有数值单元格 `white-space: nowrap`

### 3. 历史趋势

**标题行右侧 = 单行分段控件**(合并原来的两组按钮):
外壳 `--item-bg` + 1px border,radius 10,padding 3;
项 12px padding `5px 12px` radius 7;选中项 `background: rgba(255,255,255,0.10)`,文字 `--text` 600;
未选中 muted。顺序:`近6个月 | 近30天 | 计费周期` + 1px 竖分隔(16px 高)+ `总计 | 详细`。
(替换原 `.chart-actions` 两行右上角堆叠。)

**卡片**:
1. **指标条**(与图同卡,位于图上方,各栏 1px 左分隔线):
   `区间总量 796.1 GB`(20/700)、`上行 / 下行 356.1 / 440.1 GB`(紫 / 青)、`日均 26.54 GB`、
   `峰值 07-14 103.2 GB`(`#ff453a`);右侧 `margin-left:auto` 今日徽标:
   `rgba(0,122,255,0.12)` 底、`#4dd4ff` 文字、8px 呼吸圆点(`trendPulse` 2s,已存在于 style.css)。
2. **图表**,高 230px,左轴宽 46px(`120 GB / 90 / 60 / 30 / 0`):
   - 总流量线 `#4dd4ff` 2.5px,`tension 0.4 / monotone`,填充 `#4dd4ff` 0.34 → 0.02
   - 上行 / 下行虚线 `#b66cff` 0.75 / `#4dd4ff` 0.55,1.5px,`dash 4 3`(对应「详细」视图开关)
   - 均值线:`rgba(134,134,139,0.55)` 1.5px `dash 6 4` + 左端 `Avg 26.5` 胶囊
     (`rgba(134,134,139,0.75)` 底,10px 白字,radius 4)—— **胶囊垂直位置必须按均值在 Y 轴的比例定位**
   - 峰值点:半径 8 圆环,`#ff453a` 2px 描边 + `rgba(255,69,58,0.15)` 填充,
     上方 `峰值 103.2 GB` 标签(`rgba(255,69,58,0.85)` 底,10/600 白字)
   - 今日点:半径 5 `#4dd4ff` + 2px 白描边
   - X 轴 10px `#5c5c61`:`07-04 … 08-02`
   - Chart.js:沿用 `chartjs-plugin-annotation` 的 avgLine / maxPoint 注解,仅换色。

### 4. 延迟监控

**标题行右侧**(取代原来占两行的控制栏):目标筛选胶囊 `● CU`(选中态
`rgba(10,132,255,0.16)` 底 + `rgba(10,132,255,0.35)` 边)+ 分段控件 `24h | 7 天 | 自定义`
+ `更多 ▾` 胶囊。日期输入、查询/重置、丢包/极值/平均线三个开关全部收进「更多」弹层。

**卡片**自上而下:
1. **链路状态横幅**(本模块的核心,回答「现在是否正常」),高约 56px,radius 12:
   - 正常:底 `linear-gradient(90deg, rgba(48,209,88,0.12), rgba(48,209,88,0.02))`,
     边 `rgba(48,209,88,0.28)`,10px 圆点 `#30d158`(4px 光晕 + 2.4s 呼吸),
     标题 `链路正常` 17/700 `#30d158`
   - 劣化:同结构换 `#ff9f0a`,`rgba(255,159,10,0.14/0.02/0.32)`,呼吸 1.6s,文案 `链路劣化`
   - 中断:换 `#ff453a`,`rgba(255,69,58,0.14/0.02/0.34)`,呼吸 1.2s,文案 `链路中断`,
     当前延迟显示 `--`,第二格改为 `已持续 4 分钟`
   - 右侧分栏(各带 1px 左分隔线,`flex:0 0 auto`):`当前延迟 165.0 ms`(26/700)、
     `抖动 1.6 ms`、`丢包 1.0%`(`#ff9f0a`);最右 `12 秒前更新 · 粒度 1 分钟` 11px muted
   - 阈值建议:平均 < 200ms 且丢包 < 2% → 正常;丢包 ≥ 2% 或均值 > 1.5×基线 → 劣化;
     最近一个采样窗口无数据 → 中断(具体阈值由后端/前端约定,设计不锁死)
2. **指标条** 6 栏(`repeat(auto-fit,minmax(130px,1fr))`,各带左分隔线,底 1px 分隔线):
   `24h 平均 165.0 ms`、`P95 165.5 ms`、`最小 162.4 ms`、`最大 336.2 ms`(橙)、
   `丢包率 1.0%`(橙)、`异常时长 31 分钟`。标签 11px muted,值 18/700。
3. **图表**,高 220px,左轴 44px(`360 ms / 270 / 180 / 90 / 0`),右轴 40px(丢包 `100% / 75 / 50 / 25 / 0`,
   `100%` 用 `#ff453a` 0.7):
   - 延迟线 `#0a84ff` 1.4px;末点半径 4 + 白描边
   - 丢包竖条 `#ff453a` opacity 0.7,宽 ~2px,挂右轴
   - 无数据区间:`rgba(134,134,139,0.10)` 色块 + `无数据 8 分钟` 小标签
   - 异常区间:`rgba(255,159,10,0.07)` 色块 + `异常 31 分钟` 小标签(两个标签错开行,勿重叠)
   - ECharts 实现:沿用现有 `markArea` 方案,只改颜色与标签文案。
4. **图例行**(顶部 1px 分隔线,12px muted):`● CU`、`— 丢包`、`▮ 无数据`;
   右侧 `采样 1440 点 · 1 分钟粒度 · 最近 24 小时`。

---

## Interactions & Behavior

- **分段控件**(历史趋势范围/视图、延迟快捷范围):点击切换,选中态见上;对应
  `app.js` 的 `setupTrendToggle()` / `trendRange` / `trendView` 与延迟的日期范围逻辑,行为不变,只换外观。
- **「更多 ▾」**:点开一个 popover(外壳样式统一用 `.popover`,开合走 `core/dom.js` 的
  `bindPopover` —— 点击外部 / Esc 关闭),内含开始/结束日期、前后一天箭头、查询/最近24h/重置、
  丢包/极值/平均线三个 checkbox、粒度说明。
- **实时网速**:SSE 每秒推点,60 点窗口,超出 shift();窗口未满用 `null` 占位(现状保持)。
- **呼吸动画**:`trendPulse` 2s(已存在),状态圆点复用同一 keyframes,劣化 1.6s、中断 1.2s。
- **Tooltip**:沿用现有 Chart.js / ECharts tooltip 配置,仅把上行/下行的 `labelColor` 换成新的紫/青。
- **Hover**:卡片沿用现有 `border-color: var(--card-hover-border)` + `translateY(-2px)`。
- **响应式**:所有指标条用 `repeat(auto-fit, minmax(...))`,窄屏整格换行而不是格内断字;
  流量统计两卡在 <470px/列 时自动上下堆叠;`.stats-grid` 的现有断点(1000px→2 列、560px→1 列)不变。
- **浅色主题**:本轮未设计。落地时 `--speed-up` / `--speed-down` 在浅色下需降亮度
  (建议 `#8b5cf6` / `#0aa2c0`),其余走现有 `body.theme-light` 覆盖。

## State Management

无新增状态。沿用 `app.js` 现有变量:
`realtimeLabels/TxSeries/RxSeries`、`realtimeScale`、`trendRange`("monthly"|"30d"|"cycle")、
`trendView`("total"|"detail")、`latencyData`、`activeTags`、`latencyRange`、`latencyLossSeries`。
新增仅一项(可选):延迟链路状态 `"ok" | "warn" | "down"`,由 `renderLatencyStats()` 已算出的
avg / lossRate / 最近采样时间推导,不需要新接口。

## Assets

无新增图片/图标。铃铛 SVG、`favicon.svg`、PWA 图标沿用仓库现有文件。
所有图形均为 CSS/SVG 或由已内嵌的 Chart.js / ECharts 绘制,**不引入新依赖**。

## Files

实际落地位置(ESM 拆分后):

- `web/index.html` —— 四个模块的 DOM 结构(区块标题行、控件、指标条、表格)
- `web/style.css` —— 新 token 与新类
- `web/js/modules/realtime.js` —— 镜像面积图与实时读数行
- `web/js/modules/traffic.js` —— 本月总量卡 + 按协议明细表
- `web/js/modules/trend.js` —— 指标条 + 趋势图、分段控件
- `web/js/modules/latency/` —— `index.js`(状态横幅与编排)/ `stats.js`(指标条)/
  `chart.js`(ECharts)/ `palette.js`(目标配色)
- 参考:仓库 `README.md`、`CLAUDE.md`(工程约定、CHANGELOG 规范)
