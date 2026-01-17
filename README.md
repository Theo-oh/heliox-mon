# Heliox Monitor

轻量级服务器监控系统，专为 [Heliox](../heliox) 代理服务设计。

## 特性

- 📊 **系统资源监控** - CPU / 内存 / 磁盘 / 负载
- 🚀 **实时网速** - SSE 推送，1 秒刷新
- 📈 **流量统计** - 今日 / 昨日 / 本月 / 上月 / 12个月趋势
- ⚠️ **流量报警** - 多级阈值 + Telegram 通知
- 📡 **延迟监控** - 多目标 Ping + 历史图表
- 🌏 **时区统一** - Asia/Shanghai，跨地域一致

## 快速开始

### 1. 服务器端安装

```bash
# 下载最新版本
curl -fsSL https://github.com/hh/heliox-mon/releases/latest/download/heliox-mon-linux-amd64 \
    -o /usr/local/bin/heliox-mon
chmod +x /usr/local/bin/heliox-mon

# 创建配置
mkdir -p /opt/heliox-mon
cp .env.example /opt/heliox-mon/.env
vim /opt/heliox-mon/.env  # 修改密码等配置

# 安装服务
cp heliox-mon.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now heliox-mon

# 查看状态
systemctl status heliox-mon
```

### 2. 配置 Cloudflare Tunnel（可选）

```bash
cloudflared tunnel route dns your-tunnel mon.example.com
```

### 3. 访问面板

- 地址: `http://127.0.0.1:9100` 或通过 Tunnel
- 用户名: `admin`（可配置）
- 密码: `.env` 中设置

## 配置说明

| 变量                 | 说明             | 默认值           |
| -------------------- | ---------------- | ---------------- |
| `HELIOX_MON_LISTEN`  | 监听地址         | `127.0.0.1:9100` |
| `HELIOX_MON_USER`    | 用户名           | `admin`          |
| `HELIOX_MON_PASS`    | 密码             | 必填             |
| `HELIOX_ENV_PATH`    | heliox/.env 路径 | `../heliox/.env` |
| `MONTHLY_LIMIT_GB`   | 月流量限额       | `1000`           |
| `BILLING_MODE`       | 计费模式         | `bidirectional`  |
| `RESET_DAY`          | 计费周期重置日   | `1`              |
| `ALERT_THRESHOLDS`   | 报警阈值         | `80,90,95`       |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot     | 可选             |
| `TELEGRAM_CHAT_ID`   | Telegram Chat ID | 可选             |

### 计费模式

- `bidirectional` - 双向 (TX + RX)
- `tx_only` - 仅上行
- `rx_only` - 仅下行
- `max_value` - 取较大值

## 与 Heliox 集成

```bash
# 在 heliox 目录下
./deploy.sh monitor install  # 安装监控
./deploy.sh monitor start    # 启动
./deploy.sh monitor stop     # 停止
./deploy.sh monitor logs     # 查看日志
```

## 开发

```bash
# 安装依赖
make deps

# 本地构建
make dev

# 生产构建
make build
```

## API

| 端点                    | 方法 | 说明       |
| ----------------------- | ---- | ---------- |
| `/api/stats`            | GET  | 仪表盘汇总 |
| `/api/system`           | GET  | 系统资源   |
| `/api/traffic/daily`    | GET  | 每日流量   |
| `/api/traffic/monthly`  | GET  | 月度汇总   |
| `/api/traffic/realtime` | SSE  | 实时网速   |
| `/api/latency`          | GET  | 延迟历史   |

## License

MIT
