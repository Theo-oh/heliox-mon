package collector

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// doCollectTraffic 执行流量采集
func (c *Collector) doCollectTraffic() {
	now := time.Now().Unix()

	// 1. 采集整体流量
	tx, rx, err := c.readProcNetDev()
	if err != nil {
		log.Printf("读取流量数据失败: %v", err)
		return
	}

	// 保存快照
	_, err = c.db.Exec(
		"INSERT INTO traffic_snapshots (ts, iface, tx_bytes, rx_bytes) VALUES (?, 'total', ?, ?)",
		now, tx, rx,
	)
	if err != nil {
		log.Printf("保存流量快照失败: %v", err)
	}

	c.lastTotalTx = tx
	c.lastTotalRx = rx

	// 2. 采集端口流量（如果配置了端口）
	if c.cfg.SnellPort > 0 || c.cfg.VlessPort > 0 {
		c.collectPortTraffic(now)
	}
}

// readProcNetDev 从 /proc/net/dev 读取网络流量
func (c *Collector) readProcNetDev() (tx, rx uint64, err error) {
	file, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()

		// 跳过头部
		if !strings.Contains(line, ":") {
			continue
		}

		parts := strings.Split(line, ":")
		if len(parts) != 2 {
			continue
		}

		iface := strings.TrimSpace(parts[0])
		// 跳过 lo 和 docker 网桥
		if iface == "lo" || strings.HasPrefix(iface, "docker") || strings.HasPrefix(iface, "br-") || strings.HasPrefix(iface, "veth") {
			continue
		}

		fields := strings.Fields(parts[1])
		if len(fields) < 10 {
			continue
		}

		// 字段顺序: rx_bytes, rx_packets, ..., tx_bytes, tx_packets, ...
		// 索引 0 = rx_bytes, 索引 8 = tx_bytes
		ifaceRx, _ := strconv.ParseUint(fields[0], 10, 64)
		ifaceTx, _ := strconv.ParseUint(fields[8], 10, 64)

		rx += ifaceRx
		tx += ifaceTx
	}

	return tx, rx, scanner.Err()
}

// collectPortTraffic 采集端口流量（通过 iptables）
func (c *Collector) collectPortTraffic(now int64) {
	ports := []int{}
	if c.cfg.SnellPort > 0 {
		ports = append(ports, c.cfg.SnellPort)
	}
	if c.cfg.VlessPort > 0 {
		ports = append(ports, c.cfg.VlessPort)
	}

	for _, port := range ports {
		tx, rx, err := c.readIptablesPortTraffic(port)
		if err != nil {
			// iptables 规则可能不存在，静默失败
			continue
		}

		_, err = c.db.Exec(
			"INSERT INTO port_traffic_snapshots (ts, port, tx_bytes, rx_bytes) VALUES (?, ?, ?, ?)",
			now, port, tx, rx,
		)
		if err != nil {
			log.Printf("保存端口 %d 流量快照失败: %v", port, err)
		}

		c.lastPortTx[port] = tx
		c.lastPortRx[port] = rx
	}
}

// readIptablesPortTraffic 从 iptables 读取端口流量
// 需要预先设置 iptables 规则：
// iptables -N HELIOX_STATS
// iptables -I INPUT -j HELIOX_STATS
// iptables -I OUTPUT -j HELIOX_STATS
// iptables -A HELIOX_STATS -p tcp --sport <port>  # TX
// iptables -A HELIOX_STATS -p tcp --dport <port>  # RX
func (c *Collector) readIptablesPortTraffic(port int) (tx, rx uint64, err error) {
	// 读取 INPUT 链（RX = dport）
	rx, _ = c.getIptablesBytes("HELIOX_STATS", "dpt", port)
	// 读取 OUTPUT 链（TX = sport）
	tx, _ = c.getIptablesBytes("HELIOX_STATS", "spt", port)
	return tx, rx, nil
}

// getIptablesBytes 解析 iptables 输出获取字节数
func (c *Collector) getIptablesBytes(chain, portType string, port int) (uint64, error) {
	cmd := exec.Command("iptables", "-L", chain, "-n", "-v", "-x")
	output, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("iptables 命令执行失败: %w", err)
	}

	// 查找匹配的行：... dpt:443 或 spt:443
	target := fmt.Sprintf("%s:%d", portType, port)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, target) {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				bytes, _ := strconv.ParseUint(fields[1], 10, 64)
				return bytes, nil
			}
		}
	}
	// 规则不存在时返回特定错误
	return 0, fmt.Errorf("iptables 规则不存在: %s:%d", portType, port)
}
