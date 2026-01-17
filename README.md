# Heliox Monitor

轻量级服务器监控系统，专为 [Heliox](https://github.com/hh/heliox) 代理服务设计。

## 特性

- 📊 **系统资源监控** - CPU / 内存 / 磁盘 / 负载
- 🚀 **实时网速** - SSE 推送，秒级刷新
- 📈 **流量统计** - 今日 / 昨日 / 本月 / 上月 / 12个月趋势
- ⚠️ **流量报警** - 多级阈值 + Telegram 通知
- 📡 **延迟监控** - 多目标 Ping + 历史图表
- 🌏 **时区统一** - Asia/Shanghai，跨地域一致

---

## 快速部署

### 前置条件

1. VPS 已部署 [heliox](https://github.com/hh/heliox)
2. VPS 安装 Go 1.21+ (`apt install golang-go`)
3. 代码已 clone 到 `~/heliox-mon`

### 一键安装

```bash
# 1. 确保 heliox 和 heliox-mon 在同级目录
ls ~
# heliox/  heliox-mon/

# 2. 安装监控（自动编译、配置、启动服务）
cd ~/heliox
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

# 通过 Cloudflare Tunnel 外部访问
cloudflared tunnel route dns your-tunnel mon.example.com
```

---

## 命令

```bash
./deploy.sh monitor <command>

install    # 安装（编译+配置+服务）
start      # 启动
stop       # 停止
restart    # 重启
status     # 查看状态
logs       # 查看日志
update     # 更新到最新版
uninstall  # 卸载
```

---

## 多 VPS 部署

```bash
# 批量部署
for vps in vps-la vps-tyo vps-hk; do
  ssh root@$vps 'cd ~/heliox && git pull && cd ~/heliox-mon && git pull && cd ~/heliox && sudo ./deploy.sh monitor install && sudo ./deploy.sh monitor start'
done
```

每台 VPS 的 `SERVER_NAME` 自动使用主机名区分。

---

## 配置

配置文件：`/opt/heliox-mon/.env`

| 变量                 | 说明         | 默认值                            |
| -------------------- | ------------ | --------------------------------- |
| `HELIOX_MON_PASS`    | 密码         | 自动生成                          |
| `SERVER_NAME`        | 服务器标识   | 主机名                            |
| `MONTHLY_LIMIT_GB`   | 月流量限额   | 1000                              |
| `BILLING_MODE`       | 计费模式     | bidirectional                     |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot | 空                                |
| `PING_TARGETS`       | 延迟监控     | Google:8.8.8.8,Cloudflare:1.1.1.1 |

---

## 更新

```bash
# 本地修改代码后
git add . && git commit -m "..." && git push

# VPS 更新
cd ~/heliox-mon && git pull
cd ~/heliox && sudo ./deploy.sh monitor update
```

---

## 开发

```bash
# 本地交叉编译
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o build/heliox-mon-linux-amd64 ./cmd/heliox-mon
```

---

## License

MIT
