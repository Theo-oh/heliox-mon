#!/bin/bash
# Heliox Monitor - iptables 端口流量统计设置脚本
# 必须使用 sudo 运行

set -e

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    echo "错误: 请使用 sudo 运行此脚本"
    echo "用法: sudo $0"
    exit 1
fi

# 加载配置
source /opt/heliox-mon/.env 2>/dev/null || true
source /opt/heliox/.env 2>/dev/null || true

SNELL_PORT="${SNELL_PORT:-36890}"
VLESS_PORT="${VLESS_PORT:-443}"

# 查找 iptables 路径
IPTABLES=$(which iptables 2>/dev/null || echo "/usr/sbin/iptables")
if [ ! -x "$IPTABLES" ]; then
    echo "错误: 找不到 iptables，请先安装: apt install iptables"
    exit 1
fi

echo "=== Heliox Monitor iptables 设置 ==="
echo "Snell 端口: $SNELL_PORT"
echo "VLESS 端口: $VLESS_PORT"
echo ""

# 创建统计链（如果不存在）
$IPTABLES -N HELIOX_STATS 2>/dev/null || true

# 清理旧规则
$IPTABLES -F HELIOX_STATS 2>/dev/null || true

# 删除可能存在的旧跳转规则
$IPTABLES -D INPUT -j HELIOX_STATS 2>/dev/null || true
$IPTABLES -D OUTPUT -j HELIOX_STATS 2>/dev/null || true

# 添加跳转规则
$IPTABLES -I INPUT -j HELIOX_STATS
$IPTABLES -I OUTPUT -j HELIOX_STATS

# 添加端口统计规则
# Snell
if [ "$SNELL_PORT" != "0" ]; then
    $IPTABLES -A HELIOX_STATS -p tcp --sport $SNELL_PORT  # TX (服务器发送)
    $IPTABLES -A HELIOX_STATS -p tcp --dport $SNELL_PORT  # RX (服务器接收)
    $IPTABLES -A HELIOX_STATS -p udp --sport $SNELL_PORT  # TX (UDP)
    $IPTABLES -A HELIOX_STATS -p udp --dport $SNELL_PORT  # RX (UDP)
    echo "✓ Snell ($SNELL_PORT) 规则已添加"
fi

# VLESS
if [ "$VLESS_PORT" != "0" ]; then
    $IPTABLES -A HELIOX_STATS -p tcp --sport $VLESS_PORT  # TX
    $IPTABLES -A HELIOX_STATS -p tcp --dport $VLESS_PORT  # RX
    $IPTABLES -A HELIOX_STATS -p udp --sport $VLESS_PORT  # TX (UDP)
    $IPTABLES -A HELIOX_STATS -p udp --dport $VLESS_PORT  # RX (UDP)
    echo "✓ VLESS ($VLESS_PORT) 规则已添加"
fi

echo ""
echo "=== 当前规则 ==="
$IPTABLES -L HELIOX_STATS -n -v

echo ""
echo "=== 设置完成 ==="
echo "注意: 服务器重启后需要重新运行此脚本"
echo "建议添加到 /etc/rc.local 或 systemd 启动服务"
