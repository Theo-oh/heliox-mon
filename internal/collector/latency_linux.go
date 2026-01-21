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
