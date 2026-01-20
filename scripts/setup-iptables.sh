#!/bin/bash
# Heliox Monitor - iptables 端口流量统计设置脚本
# 运行一次即可，规则会在服务器重启后丢失，需要添加到启动脚本

set -e

# 加载配置
source /opt/heliox-mon/.env 2>/dev/null || true
source /opt/heliox/.env 2>/dev/null || true

SNELL_PORT="${SNELL_PORT:-36890}"
VLESS_PORT="${VLESS_PORT:-443}"

echo "=== Heliox Monitor iptables 设置 ==="
echo "Snell 端口: $SNELL_PORT"
echo "VLESS 端口: $VLESS_PORT"
echo ""

# 创建统计链（如果不存在）
iptables -N HELIOX_STATS 2>/dev/null || true

# 清理旧规则
iptables -F HELIOX_STATS 2>/dev/null || true

# 删除可能存在的旧跳转规则
iptables -D INPUT -j HELIOX_STATS 2>/dev/null || true
iptables -D OUTPUT -j HELIOX_STATS 2>/dev/null || true

# 添加跳转规则
iptables -I INPUT -j HELIOX_STATS
iptables -I OUTPUT -j HELIOX_STATS

# 添加端口统计规则
# Snell
if [ "$SNELL_PORT" != "0" ]; then
    iptables -A HELIOX_STATS -p tcp --sport $SNELL_PORT  # TX (服务器发送)
    iptables -A HELIOX_STATS -p tcp --dport $SNELL_PORT  # RX (服务器接收)
    echo "✓ Snell ($SNELL_PORT) 规则已添加"
fi

# VLESS
if [ "$VLESS_PORT" != "0" ]; then
    iptables -A HELIOX_STATS -p tcp --sport $VLESS_PORT  # TX
    iptables -A HELIOX_STATS -p tcp --dport $VLESS_PORT  # RX
    echo "✓ VLESS ($VLESS_PORT) 规则已添加"
fi

echo ""
echo "=== 当前规则 ==="
iptables -L HELIOX_STATS -n -v

echo ""
echo "=== 设置完成 ==="
echo "注意: 服务器重启后需要重新运行此脚本"
echo "建议添加到 /etc/rc.local 或 systemd 启动服务"
