package collector

import (
	"log"
	"math"
	"net"
	"sort"
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
	today := now.Format("2006-01-02")
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")

	// 汇总整体流量（今日 + 昨日）
	c.aggregateDailyTraffic(today)
	c.aggregateDailyTraffic(yesterday)

	// 汇总端口流量（今日 + 昨日）
	c.aggregatePortDailyTraffic(today)
	c.aggregatePortDailyTraffic(yesterday)

	// 汇总延迟数据（降采样）
	c.aggregateLatencyData()

	// 清理过期快照
	c.cleanupOldSnapshots()

	// 检查配额并发送通知
	c.checkQuotaAndNotify(now)
}

func (c *Collector) dayBounds(date string) (int64, int64, bool) {
	start, err := time.ParseInLocation("2006-01-02", date, c.cfg.Timezone)
	if err != nil {
		return 0, 0, false
	}
	end := start.Add(24*time.Hour - time.Second)
	return start.Unix(), end.Unix(), true
}

// aggregateDailyTraffic 汇总每日整体流量
func (c *Collector) aggregateDailyTraffic(date string) {
	startTs, endTs, ok := c.dayBounds(date)
	if !ok {
		return
	}

	// 获取当天的流量增量
	row := c.db.QueryRow(`
		SELECT MAX(tx_bytes) - MIN(tx_bytes), MAX(rx_bytes) - MIN(rx_bytes)
		FROM traffic_snapshots
		WHERE iface = 'total'
		  AND ts >= ? AND ts <= ?
	`, startTs, endTs)

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
	startTs, endTs, ok := c.dayBounds(date)
	if !ok {
		return
	}

	ports := []int{c.cfg.SnellPort, c.cfg.VlessPort}
	for _, port := range ports {
		if port == 0 {
			continue
		}

		row := c.db.QueryRow(`
			SELECT MAX(tx_bytes) - MIN(tx_bytes), MAX(rx_bytes) - MIN(rx_bytes)
			FROM port_traffic_snapshots
			WHERE port = ?
			  AND ts >= ? AND ts <= ?
		`, port, startTs, endTs)

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
	// 保留最近 24 小时的流量快照（足够日汇总计算）
	cutoff := time.Now().Add(-24 * time.Hour).Unix()
	_, _ = c.db.Exec("DELETE FROM traffic_snapshots WHERE ts < ?", cutoff)
	_, _ = c.db.Exec("DELETE FROM port_traffic_snapshots WHERE ts < ?", cutoff)
}

// checkQuotaAndNotify 检查流量配额并发送通知
func (c *Collector) checkQuotaAndNotify(now time.Time) {
	if c.notifier == nil || c.cfg.MonthlyLimitGB <= 0 {
		return
	}

	// 获取计费周期
	billingStart, billingEnd := c.getBillingCycleDates(now)

	// 查询本月已用流量（按 tx/rx 分开计算）
	var tx, rx int64
	row := c.db.QueryRow(`
		SELECT COALESCE(SUM(tx_bytes), 0), COALESCE(SUM(rx_bytes), 0)
		FROM traffic_daily
		WHERE date >= ? AND iface = 'total'
	`, billingStart.Format("2006-01-02"))
	row.Scan(&tx, &rx)

	var usedBytes int64
	switch c.cfg.BillingMode {
	case "tx_only":
		usedBytes = tx
	case "rx_only":
		usedBytes = rx
	case "max_value":
		if tx > rx {
			usedBytes = tx
		} else {
			usedBytes = rx
		}
	default: // bidirectional
		usedBytes = tx + rx
	}

	limitGB := c.cfg.MonthlyLimitGB
	limitBytes := int64(limitGB) * 1024 * 1024 * 1024
	if limitBytes <= 0 {
		return
	}

	percent := float64(usedBytes) / float64(limitBytes) * 100
	usedGB := int(math.Round(float64(usedBytes) / float64(1024*1024*1024)))
	daysLeft := int(billingEnd.Sub(now).Hours() / 24)

	thresholds := append([]int(nil), c.cfg.AlertThresholds...)
	sort.Ints(thresholds)
	for _, threshold := range thresholds {
		if threshold <= 0 {
			continue
		}
		if percent >= float64(threshold) {
			resetDate := billingEnd.Format("2006-01-02")
			if err := c.notifier.SendTrafficAlert(usedGB, limitGB, percent, resetDate, daysLeft, threshold); err != nil {
				log.Printf("发送流量预警失败: %v", err)
			}
		}
	}
}

// getBillingCycleDates 计算计费周期
func (c *Collector) getBillingCycleDates(now time.Time) (start, end time.Time) {
	day := c.cfg.ResetDay
	tz := c.cfg.Timezone

	if now.Day() >= day {
		start = time.Date(now.Year(), now.Month(), day, 0, 0, 0, 0, tz)
		end = time.Date(now.Year(), now.Month()+1, day, 0, 0, 0, 0, tz).Add(-time.Second)
	} else {
		start = time.Date(now.Year(), now.Month()-1, day, 0, 0, 0, 0, tz)
		end = time.Date(now.Year(), now.Month(), day, 0, 0, 0, 0, tz).Add(-time.Second)
	}
	return
}
