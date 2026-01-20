# Heliox Monitor

轻量级服务器监控系统，专为 [Heliox](https://github.com/Theo-oh/heliox) 代理服务设计。

## 特性

- 📊 **系统资源监控** - CPU / 内存 / 磁盘 / 负载（实时 5 秒刷新）
- 🚀 **实时网速** - SSE 推送，1 秒刷新
- 📈 **流量统计** - 今日 / 昨日 / 本月 / 上月（每分钟更新）
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

## 更新日志

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
