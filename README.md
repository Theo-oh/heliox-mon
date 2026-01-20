# Heliox Monitor

轻量级服务器监控系统，专为 [Heliox](https://github.com/Theo-oh/heliox) 代理服务设计。

## 特性

- 📊 **系统资源监控** - CPU / 内存 / 磁盘 / 负载
- 🚀 **实时网速** - SSE 推送，秒级刷新
- 📈 **流量统计** - 今日 / 昨日 / 本月 / 上月趋势
- ⚠️ **流量报警** - 多级阈值 + Telegram 通知
- 📡 **延迟监控** - 多目标 Ping + 统计图表
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

## 多 VPS 部署

```bash
for vps in vps-la vps-tyo vps-hk; do
  ssh root@$vps 'cd ~/heliox && git pull && sudo ./deploy.sh monitor install && sudo ./deploy.sh monitor start'
done
```

每台 VPS 的 `SERVER_NAME` 自动使用主机名区分。

---

## 配置

配置文件：`/opt/heliox-mon/.env`

| 变量                 | 说明       | 默认值                            |
| -------------------- | ---------- | --------------------------------- |
| `HELIOX_MON_PASS`    | 密码       | 自动生成                          |
| `SERVER_NAME`        | 服务器标识 | 主机名                            |
| `MONTHLY_LIMIT_GB`   | 月流量限额 | 1000                              |
| `TELEGRAM_BOT_TOKEN` | Telegram   | 空                                |
| `PING_TARGETS`       | 延迟监控   | Google:8.8.8.8,Cloudflare:1.1.1.1 |

修改后执行 `sudo ./deploy.sh monitor restart` 生效。

---

## 更新

```bash
cd ~/heliox && git pull
sudo ./deploy.sh monitor update
```

---

## License

MIT
