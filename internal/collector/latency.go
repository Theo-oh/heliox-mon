package collector

import (
	"encoding/json"
	"log"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// latencySummary 一次探测（或一个时间桶）的摘要。
// RTT 类指针：nil 表示该次无有效 RTT（如全丢包），与 0ms 区分。
type latencySummary struct {
	Avg    *float64
	Min    *float64
	Max    *float64
	P95    *float64
	Mdev   *float64 // 成功包的总体标准差，口径对齐 iputils mdev
	SumRTT float64
	SumSq  float64
	Recv   int
	Sent   int
	Lost   int
	RTTs   []float64
}

var (
	rePingStats  = regexp.MustCompile(`(\d+) packets transmitted, (\d+) (?:packets )?received`)
	rePingRTT    = regexp.MustCompile(`rtt min/avg/max/(?:mdev|stddev) = ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)`)
	rePingRTTAlt = regexp.MustCompile(`(?:rtt|round-trip) [^=]*= ([\d.]+)/([\d.]+)/([\d.]+)(?:/([\d.]+))?`)
	// 逐包：优先带 seq 去重；无 seq 时退回纯 time=
	rePingReply    = regexp.MustCompile(`(?:icmp_seq|seq)=(\d+).*?\btime[=<]([\d.]+)`)
	rePingTimeOnly = regexp.MustCompile(`\btime[=<]([\d.]+)\s*ms`)
)

const insertLatencySQL = `INSERT INTO latency_records
	(ts, target, rtt_ms, min_rtt, mdev, sent, lost, is_aggregated,
	 max_rtt, p95_rtt, sum_rtt, sum_sq, recv, rtts)
	VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`

func (c *Collector) insertLatency(ts int64, target string, s latencySummary) error {
	_, err := c.db.Exec(insertLatencySQL,
		ts, target, s.Avg, s.Min, s.Mdev, s.Sent, s.Lost,
		s.Max, s.P95, s.SumRTT, s.SumSq, s.Recv, s.rttsJSON(),
	)
	return err
}

func (s latencySummary) rttsJSON() interface{} {
	if len(s.RTTs) == 0 {
		return nil
	}
	b, err := json.Marshal(roundRTTs(s.RTTs))
	if err != nil {
		log.Printf("序列化 RTT 样本失败: %v", err)
		return nil
	}
	return string(b)
}

// summarizeSamples 从成功包 RTT 计算可合并摘要。sent/lost 以探测统计为准，
// 不从成功包数反推——ping 的 received 与解析到的 time= 行偶尔会对不上。
func summarizeSamples(samples []float64, sent, lost int) latencySummary {
	if lost < 0 {
		lost = 0
	}
	s := latencySummary{Sent: sent, Lost: lost, Recv: len(samples)}
	if len(samples) == 0 {
		return s
	}
	min := samples[0]
	max := samples[0]
	var sum, sumSq float64
	for _, v := range samples {
		if v < min {
			min = v
		}
		if v > max {
			max = v
		}
		sum += v
		sumSq += v * v
	}
	n := float64(len(samples))
	avg := sum / n
	variance := sumSq/n - avg*avg
	if variance < 0 {
		variance = 0
	}
	mdev := math.Sqrt(variance)
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	p95 := percentileNearestRank(sorted, 0.95)

	s.Avg = floatPtr(avg)
	s.Min = floatPtr(min)
	s.Max = floatPtr(max)
	s.P95 = floatPtr(p95)
	s.Mdev = floatPtr(mdev)
	s.SumRTT = sum
	s.SumSq = sumSq
	s.RTTs = samples
	return s
}

// percentileNearestRank 近邻秩：1-based rank = ceil(p*n)。
// n=20 时 P95 是第 19 小（不是 max）；n=5 时 P95 就是 max，样本量不够时理应如此。
func percentileNearestRank(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 1 {
		return sorted[n-1]
	}
	rank := int(math.Ceil(p * float64(n)))
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}

func floatPtr(v float64) *float64 { return &v }

func roundRTTs(in []float64) []float64 {
	out := make([]float64, len(in))
	for i, v := range in {
		out[i] = math.Round(v*1000) / 1000
	}
	return out
}

// parsePingOutput 解析系统 ping 输出。有逐包 time= 时以样本为准计算摘要；
// 只有统计行（例如旧测试夹具 / -q 输出）时退回 min/avg/max/mdev 行。
func parsePingOutput(output string) (latencySummary, bool) {
	match := rePingStats.FindStringSubmatch(output)
	if match == nil {
		return latencySummary{}, false
	}
	transmitted, _ := strconv.Atoi(match[1])
	received, _ := strconv.Atoi(match[2])
	lost := transmitted - received
	if lost < 0 {
		lost = 0
	}

	samples := extractPingTimes(output)
	if len(samples) > 0 {
		return summarizeSamples(samples, transmitted, lost), true
	}
	if received == 0 {
		return latencySummary{Sent: transmitted, Lost: lost}, true
	}

	min, avg, max, mdev := parseRTTLine(output)
	s := latencySummary{Sent: transmitted, Lost: lost, Recv: received, Min: min, Avg: avg, Max: max, Mdev: mdev}
	if avg != nil && received > 0 {
		n := float64(received)
		s.SumRTT = *avg * n
		if mdev != nil {
			s.SumSq = ((*mdev)*(*mdev) + (*avg)*(*avg)) * n
		} else {
			s.SumSq = (*avg) * (*avg) * n
		}
	} else if avg == nil {
		log.Printf("警告：无法解析 ping 输出的 RTT：%s", trimForLog(output))
	}
	return s, true
}

func extractPingTimes(output string) []float64 {
	reply := rePingReply.FindAllStringSubmatch(output, -1)
	if len(reply) > 0 {
		seen := make(map[int]struct{}, len(reply))
		samples := make([]float64, 0, len(reply))
		for _, m := range reply {
			seq, err := strconv.Atoi(m[1])
			if err != nil {
				continue
			}
			if _, ok := seen[seq]; ok {
				continue
			}
			v, err := strconv.ParseFloat(m[2], 64)
			if err != nil {
				continue
			}
			seen[seq] = struct{}{}
			samples = append(samples, v)
		}
		return samples
	}
	only := rePingTimeOnly.FindAllStringSubmatch(output, -1)
	if len(only) == 0 {
		return nil
	}
	samples := make([]float64, 0, len(only))
	for _, m := range only {
		v, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		samples = append(samples, v)
	}
	return samples
}

func parseRTTLine(output string) (min, avg, max, mdev *float64) {
	m := rePingRTT.FindStringSubmatch(output)
	if m == nil {
		m = rePingRTTAlt.FindStringSubmatch(output)
	}
	if m == nil {
		return nil, nil, nil, nil
	}
	min = parseFloatGroup(m, 1)
	avg = parseFloatGroup(m, 2)
	max = parseFloatGroup(m, 3)
	if len(m) > 4 && m[4] != "" {
		mdev = parseFloatGroup(m, 4)
	}
	return min, avg, max, mdev
}

func parseFloatGroup(m []string, i int) *float64 {
	if i >= len(m) || m[i] == "" {
		return nil
	}
	v, err := strconv.ParseFloat(m[i], 64)
	if err != nil {
		return nil
	}
	return &v
}

func trimForLog(output string) string {
	s := strings.TrimSpace(output)
	if len(s) > 240 {
		s = s[:240]
	}
	return s
}
