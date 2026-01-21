package collector

import (
	"log"
	"net"
	"os"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// doCollectLatency 执行延迟采集
func (c *Collector) doCollectLatency() {
	now := time.Now().Unix()

	for _, target := range c.cfg.PingTargets {
		rttMs, sent, lost := c.pingStats(target.IP)

		// 使用 tag 作为 target 标识
		_, dbErr := c.db.Exec(
			"INSERT INTO latency_records (ts, target, rtt_ms, sent, lost, is_aggregated) VALUES (?, ?, ?, ?, ?, 0)",
			now, target.Tag, rttMs, sent, lost,
		)
		if dbErr != nil {
			log.Printf("保存延迟记录失败: %v", dbErr)
		}
	}
}

// pingStats 对目标进行多次 ping，返回平均 RTT（ms）、发送次数、丢失次数
func (c *Collector) pingStats(target string) (*float64, int, int) {
	count := c.cfg.PingCount
	if count <= 0 {
		count = 5
	}
	timeout := c.cfg.PingTimeout
	if timeout <= 0 {
		timeout = 1 * time.Second
	}
	gap := c.cfg.PingGap
	if gap <= 0 {
		gap = 200 * time.Millisecond
	}

	rtts, lost := c.pingMulti(target, count, timeout, gap)
	sent := count
	if len(rtts) == 0 {
		return nil, sent, lost
	}

	var sum time.Duration
	for _, rtt := range rtts {
		sum += rtt
	}
	avg := float64(sum.Microseconds()) / 1000.0 / float64(len(rtts))
	return &avg, sent, lost
}

func (c *Collector) pingMulti(target string, count int, timeout time.Duration, gap time.Duration) ([]time.Duration, int) {
	conn, err := icmp.ListenPacket("udp4", "0.0.0.0")
	if err != nil {
		return nil, count
	}
	defer conn.Close()

	dst, err := net.ResolveIPAddr("ip4", target)
	if err != nil {
		return nil, count
	}

	rtts := make([]time.Duration, 0, count)
	lost := 0

	for i := 0; i < count; i++ {
		seq := i + 1
		msg := icmp.Message{
			Type: ipv4.ICMPTypeEcho,
			Code: 0,
			Body: &icmp.Echo{
				ID:   os.Getpid() & 0xffff,
				Seq:  seq,
				Data: []byte("HELIOX"),
			},
		}
		msgBytes, err := msg.Marshal(nil)
		if err != nil {
			lost++
			continue
		}

		start := time.Now()
		if _, err := conn.WriteTo(msgBytes, &net.UDPAddr{IP: dst.IP}); err != nil {
			lost++
			continue
		}

		conn.SetReadDeadline(time.Now().Add(timeout))
		reply := make([]byte, 1500)
		n, _, err := conn.ReadFrom(reply)
		if err != nil {
			lost++
		} else {
			msg, err := icmp.ParseMessage(1, reply[:n])
			if err != nil || msg.Type != ipv4.ICMPTypeEchoReply {
				lost++
			} else {
				rtts = append(rtts, time.Since(start))
			}
		}

		if i < count-1 {
			time.Sleep(gap)
		}
	}

	return rtts, lost
}
