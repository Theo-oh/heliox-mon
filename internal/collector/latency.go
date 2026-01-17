package collector

import (
	"log"
	"net"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// doCollectLatency 执行延迟采集
func (c *Collector) doCollectLatency() {
	now := time.Now().Unix()

	for _, target := range c.cfg.PingTargets {
		rtt, err := c.ping(target.IP)

		var rttMs *float64
		if err == nil {
			ms := float64(rtt.Microseconds()) / 1000.0
			rttMs = &ms
		}

		// 使用 tag 作为 target 标识
		_, dbErr := c.db.Exec(
			"INSERT INTO latency_records (ts, target, rtt_ms, is_aggregated) VALUES (?, ?, ?, 0)",
			now, target.Tag, rttMs,
		)
		if dbErr != nil {
			log.Printf("保存延迟记录失败: %v", dbErr)
		}
	}
}

// ping 发送 ICMP ping 并返回 RTT
func (c *Collector) ping(target string) (time.Duration, error) {
	conn, err := icmp.ListenPacket("udp4", "0.0.0.0")
	if err != nil {
		return 0, err
	}
	defer conn.Close()

	dst, err := net.ResolveIPAddr("ip4", target)
	if err != nil {
		return 0, err
	}

	msg := icmp.Message{
		Type: ipv4.ICMPTypeEcho,
		Code: 0,
		Body: &icmp.Echo{
			ID:   1,
			Seq:  1,
			Data: []byte("HELIOX"),
		},
	}
	msgBytes, err := msg.Marshal(nil)
	if err != nil {
		return 0, err
	}

	start := time.Now()

	if _, err := conn.WriteTo(msgBytes, &net.UDPAddr{IP: dst.IP}); err != nil {
		return 0, err
	}

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	reply := make([]byte, 1500)
	_, _, err = conn.ReadFrom(reply)
	if err != nil {
		return 0, err
	}

	return time.Since(start), nil
}

// doDailyAggregation 执行日汇总
func (c *Collector) doDailyAggregation() {
	now := time.Now().In(c.cfg.Timezone)
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")

	// 汇总整体流量
	c.aggregateDailyTraffic(yesterday)

	// 汇总端口流量
	c.aggregatePortDailyTraffic(yesterday)

	// 汇总延迟数据（降采样）
	c.aggregateLatencyData()

	// 清理过期快照
	c.cleanupOldSnapshots()
}

// aggregateDailyTraffic 汇总每日整体流量
func (c *Collector) aggregateDailyTraffic(date string) {
	// 获取当天的流量增量
	row := c.db.QueryRow(`
		SELECT MAX(tx_bytes) - MIN(tx_bytes), MAX(rx_bytes) - MIN(rx_bytes)
		FROM traffic_snapshots
		WHERE iface = 'total'
		  AND date(ts, 'unixepoch', '+8 hours') = ?
	`, date)

	var tx, rx int64
	if err := row.Scan(&tx, &rx); err != nil || (tx <= 0 && rx <= 0) {
		return
	}

	// 插入或更新日汇总
	_, _ = c.db.Exec(`
		INSERT INTO traffic_daily (date, iface, tx_bytes, rx_bytes)
		VALUES (?, 'total', ?, ?)
		ON CONFLICT(date, iface) DO UPDATE SET tx_bytes = excluded.tx_bytes, rx_bytes = excluded.rx_bytes
	`, date, tx, rx)
}

// aggregatePortDailyTraffic 汇总端口流量
func (c *Collector) aggregatePortDailyTraffic(date string) {
	ports := []int{c.cfg.SnellPort, c.cfg.VlessPort}
	for _, port := range ports {
		if port == 0 {
			continue
		}

		row := c.db.QueryRow(`
			SELECT MAX(tx_bytes) - MIN(tx_bytes), MAX(rx_bytes) - MIN(rx_bytes)
			FROM port_traffic_snapshots
			WHERE port = ?
			  AND date(ts, 'unixepoch', '+8 hours') = ?
		`, port, date)

		var tx, rx int64
		if err := row.Scan(&tx, &rx); err != nil || (tx <= 0 && rx <= 0) {
			continue
		}

		_, _ = c.db.Exec(`
			INSERT INTO port_traffic_daily (date, port, tx_bytes, rx_bytes)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(date, port) DO UPDATE SET tx_bytes = excluded.tx_bytes, rx_bytes = excluded.rx_bytes
		`, date, port, tx, rx)
	}
}

// aggregateLatencyData 延迟数据降采样
func (c *Collector) aggregateLatencyData() {
	// 删除 7 天前的原始数据，保留聚合数据
	cutoff := time.Now().Add(-7 * 24 * time.Hour).Unix()
	_, _ = c.db.Exec("DELETE FROM latency_records WHERE ts < ? AND is_aggregated = 0", cutoff)
}

// cleanupOldSnapshots 清理过期快照
func (c *Collector) cleanupOldSnapshots() {
	// 保留最近 48 小时的流量快照
	cutoff := time.Now().Add(-48 * time.Hour).Unix()
	_, _ = c.db.Exec("DELETE FROM traffic_snapshots WHERE ts < ?", cutoff)
	_, _ = c.db.Exec("DELETE FROM port_traffic_snapshots WHERE ts < ?", cutoff)
}
