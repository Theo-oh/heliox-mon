# Heliox Monitor

轻量级服务器监控系统，专为 [Heliox](https://github.com/Theo-oh/heliox) 代理服务设计。

## 特性

- 📊 **系统资源监控** - CPU / 内存 / 磁盘 / 负载（实时 5 秒刷新）
- 🚀 **实时网速** - SSE 推送，1 秒刷新
- 📈 **流量统计** - 今日 / 昨日 / 本月 / 上月（每分钟更新）
- 🔌 **端口流量** - Snell / VLESS 分别统计，支持自定义端口
- ⚠️ **流量配额** - 支持自定义计费周期（ResetDay）和计费模式（billing_mode）
- 📡 **延迟监控** - 多目标 Ping，交互式时间范围选择，动态粒度聚合
- 📊 **月度趋势** - 近 6 个月流量趋势图
- 📦 **单文件部署** - 前端嵌入二进制，下载即用

---

## 快速部署

### 前置条件

VPS 已部署 [heliox](https://github.com/Theo-oh/heliox)

### 一键安装

```bash
# 1. 进入 heliox 目录
cd ~/heliox && git pull

# 2. 安装监控
sudo ./deploy.sh monitor install

# 3. 启动
sudo ./deploy.sh monitor start

# 4. 查看密码
cat /opt/heliox-mon/.env | grep PASS
```

### 访问

```bash
# 本地测试
curl -u admin:密码 http://127.0.0.1:9100/api/system

# 通过 Cloudflare Tunnel 外部访问（配置 URL: http://host.docker.internal:9100）
```

---

## 命令

```bash
./deploy.sh monitor <command>

install    # 安装
start      # 启动
stop       # 停止
restart    # 重启
status     # 查看状态
logs       # 查看日志
update     # 更新到最新版
uninstall  # 卸载
```

---

## 配置

配置文件：`/opt/heliox-mon/.env`

| 变量                 | 说明           | 默认值                            |
| -------------------- | -------------- | --------------------------------- |
| `HELIOX_MON_PASS`    | 密码           | 自动生成                          |
| `SERVER_NAME`        | 服务器标识     | 主机名                            |
| `HELIOX_MON_TZ`      | 时区           | Asia/Shanghai                     |
| `MONTHLY_LIMIT_GB`   | 月流量限额(GB) | 1000                              |
| `BILLING_MODE`       | 计费模式       | bidirectional                     |
| `RESET_DAY`          | 计费周期重置日 | 1 (每月1号)                       |
| `TELEGRAM_BOT_TOKEN` | Telegram 通知  | 空                                |
| `PING_TARGETS`       | 延迟监控目标   | Google:8.8.8.8,Cloudflare:1.1.1.1 |

### 计费模式 (BILLING_MODE)

| 值            | 说明              |
| ------------- | ----------------- |
| bidirectional | 上行+下行 (默认)  |
| tx_only       | 仅计算上行        |
| rx_only       | 仅计算下行        |
| max_value     | 取上行/下行较大值 |

修改后执行 `sudo ./deploy.sh monitor restart` 生效。

---

## 多 VPS 部署

```bash
for vps in vps-la vps-tyo vps-hk; do
  ssh root@$vps 'cd ~/heliox && git pull && sudo ./deploy.sh monitor install && sudo ./deploy.sh monitor start'
done
```

每台 VPS 的 `SERVER_NAME` 自动使用主机名区分。

---

## 更新

```bash
cd ~/heliox && git pull
sudo ./deploy.sh monitor update
```

---

## 端口流量监控

支持按端口（如 Snell、VLESS）分别统计流量，显示各协议的今日/昨日/本月使用量。

### 工作原理

使用 iptables 计数器统计端口流量：

- 创建 `HELIOX_STATS` 链统计进出流量
- 按端口分别记录上行（TX）和下行（RX）
- 同时统计 TCP/UDP
- 每秒采集快照，每分钟汇总到日统计

### 自动配置

**无需手动操作。** 执行 `./deploy.sh monitor install` 时自动完成以下配置：

1. 生成 iptables 规则脚本 `/opt/heliox-mon/setup-iptables.sh`
2. 配置 systemd `ExecStartPre` 自动恢复规则
3. **服务器重启后自动恢复**，无需 rc.local 或 iptables-persistent

验证规则：

```bash
iptables -L HELIOX_STATS -n -v
```

### 配置端口

端口从 Heliox 的 `/opt/heliox/.env` 文件自动读取：

| 变量         | 说明       | 示例  |
| ------------ | ---------- | ----- |
| `SNELL_PORT` | Snell 端口 | 36890 |
| `VLESS_PORT` | VLESS 端口 | 443   |

### 数据持久化

- 流量快照保留 24 小时
- 日统计永久保存在 SQLite 数据库
- 重启服务不影响历史数据

## 更新日志

### v0.8.5 (2025-01-22)

- 📊 **图表引擎升级** - 迁移至 ECharts，性能与交互体验显著提升
- 🌓 **主题切换** - 支持浅色/深色模式手动切换
- ⚡ **细节优化** - 重构延迟卡片布局，优化移动端显示

### v0.8.4 (2025-01-22)

- 📅 **交互优化** - 延迟监控支持自定义起止日期范围查询
- 🎨 **视觉微调** - 优化时间滑块样式，调整图表高度与布局
- ⚡ **体验升级** - 图表曲线更平滑，支持点击交互

### v0.8.3 (2025-01-22)

- 🖥️ **Mac Mock Mode** - 支持在 Mac 本地运行开发，自动生成模拟数据
- ⚡ **延迟监控升级** - 新增运营商筛选 (Pills)、极值/平均线高亮、优化图表交互
- 🛠️ **代码重构** - 拆分 Linux/Darwin 采集逻辑，优化跨平台结构

### v0.8.2

- 📈 **延迟监控升级** - 新增前后天切换、24小时滑块过滤、极值气泡高亮
- 🧹 **视觉优化** - 移除流量列表分隔线，优化卡片间距，月份统计居中
- 🐛 **细节修复** - 修复图表容器高度适配，系统状态栏字体微调

### v0.8.1

- 💄 **UI 微调** - 流量卡片改为垂直布局，上传/下载/总计对齐优化
- 🏷️ **体验优化** - 协议名称统一小写，标题改为 Heliox-Monitor，服务器名称移至右上角
- 🐛 **样式修复** - 修复系统状态栏布局拥挤问题

### v0.8.0

- 🎨 **全新 UI 设计** - 采用 Apple 风格深色主题，毛玻璃特效（Glassmorphism）
- ✨ **布局优化** - 居中卡片式布局，大屏体验更佳
- 📊 **图表升级** - 配色与新主题深度融合，细节更精致

### v0.5.0

- ⚡ iptables 规则自动配置（无需手动执行脚本）
- ⚡ 服务重启自动恢复规则（ExecStartPre 持久化）

### v0.4.0

- ✨ 端口流量统计（Snell/VLESS 分别统计）
- ✨ 今日/昨日/本月端口流量明细

### v0.3.0

- ✨ 延迟监控支持交互式时间范围选择
- ✨ 动态粒度聚合（保持约 1440 个数据点）

### v0.2.x

- 🐛 修复 CPU 使用率计算（改用两次采样差值算法）
- 🐛 修复今日流量显示为 0（启动时立即执行日汇总）
- 🐛 修复月度趋势报错（显示完整 6 个月）
- ✨ 实现 ResetDay 计费周期重置
- ✨ 实现 billing_mode 计费模式
- ⚡ 实时网速刷新从 3 秒改为 1 秒
- ⚡ 日汇总频率从 1 小时改为 1 分钟
- ⚡ 图表更新禁用动画避免闪烁

---

## License

MIT
