package collector

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/hh/heliox-mon/internal/storage"
)

func TestPercentileNearestRank(t *testing.T) {
	// 1..20：ceil(0.95*20)=19 → 第 19 小 = 19，不是 max
	n20 := make([]float64, 20)
	for i := 0; i < 20; i++ {
		n20[i] = float64(i + 1)
	}
	if got := percentileNearestRank(n20, 0.95); got != 19 {
		t.Errorf("n=20 P95 = %v, want 19", got)
	}
	if got := percentileNearestRank(n20, 0); got != 1 {
		t.Errorf("p=0 = %v, want 1", got)
	}
	if got := percentileNearestRank(n20, 1); got != 20 {
		t.Errorf("p=1 = %v, want 20", got)
	}

	// n=5 时 P95 就是 max，样本量不够分位
	n5 := []float64{1, 2, 3, 4, 5}
	if got := percentileNearestRank(n5, 0.95); got != 5 {
		t.Errorf("n=5 P95 = %v, want 5", got)
	}
}

func TestSummarizeSamples(t *testing.T) {
	samples := []float64{10, 12, 11, 20, 13}
	s := summarizeSamples(samples, 5, 0)
	if s.Sent != 5 || s.Lost != 0 || s.Recv != 5 {
		t.Fatalf("sent/lost/recv = %d/%d/%d, want 5/0/5", s.Sent, s.Lost, s.Recv)
	}
	if s.Min == nil || *s.Min != 10 {
		t.Errorf("min = %v, want 10", formatFloatPtr(s.Min))
	}
	if s.Max == nil || *s.Max != 20 {
		t.Errorf("max = %v, want 20", formatFloatPtr(s.Max))
	}
	if s.Avg == nil || math.Abs(*s.Avg-13.2) > 0.001 {
		t.Errorf("avg = %v, want 13.2", formatFloatPtr(s.Avg))
	}
	if s.P95 == nil || *s.P95 != 20 { // n=5 → P95 = max
		t.Errorf("p95 = %v, want 20", formatFloatPtr(s.P95))
	}
	if s.SumRTT != 66 {
		t.Errorf("sumRTT = %v, want 66", s.SumRTT)
	}

	empty := summarizeSamples(nil, 5, 5)
	if empty.Avg != nil || empty.Recv != 0 || empty.Lost != 5 {
		t.Errorf("全丢包摘要应无 RTT: %+v", empty)
	}
}

func TestParsePingOutput(t *testing.T) {
	tests := []struct {
		name     string
		output   string
		wantOK   bool
		wantRTT  *float64
		wantMin  *float64
		wantMax  *float64
		wantMdev *float64
		wantSent int
		wantLost int
		wantN    int // 逐包样本数；-1 表示不校验
	}{
		{
			name: "逐包输出",
			output: `PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.
64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=10.000 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=12.000 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=117 time=11.000 ms
64 bytes from 8.8.8.8: icmp_seq=4 ttl=117 time=20.000 ms
64 bytes from 8.8.8.8: icmp_seq=5 ttl=117 time=13.000 ms

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 800ms
rtt min/avg/max/mdev = 10.000/13.200/20.000/3.487 ms`,
			wantOK:   true,
			wantRTT:  floatPtr(13.2),
			wantMin:  floatPtr(10),
			wantMax:  floatPtr(20),
			wantSent: 5,
			wantLost: 0,
			wantN:    5,
		},
		{
			name: "摘要行兜底（无逐包 time=）",
			output: `PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 4005ms
rtt min/avg/max/mdev = 10.123/15.456/20.789/3.214 ms`,
			wantOK:   true,
			wantRTT:  floatPtr(15.456),
			wantMin:  floatPtr(10.123),
			wantMax:  floatPtr(20.789),
			wantMdev: floatPtr(3.214),
			wantSent: 5,
			wantLost: 0,
			wantN:    0,
		},
		{
			name: "部分丢包",
			output: `64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=10.0 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=117 time=15.0 ms
64 bytes from 8.8.8.8: icmp_seq=5 ttl=117 time=12.5 ms
--- 8.8.8.8 ping statistics ---
5 packets transmitted, 3 received, 40% packet loss, time 4005ms
rtt min/avg/max/mdev = 10.0/12.5/15.0/2.5 ms`,
			wantOK:   true,
			wantRTT:  floatPtr(12.5),
			wantMin:  floatPtr(10.0),
			wantMax:  floatPtr(15.0),
			wantSent: 5,
			wantLost: 2,
			wantN:    3,
		},
		{
			name: "全部丢包",
			output: `--- 192.168.99.99 ping statistics ---
5 packets transmitted, 0 received, 100% packet loss, time 4090ms`,
			wantOK:   true,
			wantRTT:  nil,
			wantMin:  nil,
			wantMax:  nil,
			wantMdev: nil,
			wantSent: 5,
			wantLost: 5,
			wantN:    0,
		},
		{
			name: "旧版 ping 格式 (stddev)",
			output: `--- 1.1.1.1 ping statistics ---
10 packets transmitted, 10 received, 0% packet loss, time 9010ms
rtt min/avg/max/stddev = 8.000/10.500/12.000/1.234 ms`,
			wantOK:   true,
			wantRTT:  floatPtr(10.500),
			wantMin:  floatPtr(8.000),
			wantMax:  floatPtr(12.000),
			wantMdev: floatPtr(1.234),
			wantSent: 10,
			wantLost: 0,
			wantN:    0,
		},
		{
			name: "BSD round-trip 无 stddev",
			output: `--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss
round-trip min/avg/max = 8.0/10.0/12.0 ms`,
			wantOK:   true,
			wantRTT:  floatPtr(10.0),
			wantMin:  floatPtr(8.0),
			wantMax:  floatPtr(12.0),
			wantSent: 3,
			wantLost: 0,
			wantN:    0,
		},
		{
			name: "重复 icmp_seq 只计一次",
			output: `64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=10.0 ms
64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=99.0 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=12.0 ms
--- 8.8.8.8 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss
rtt min/avg/max/mdev = 10.0/11.0/12.0/1.0 ms`,
			wantOK:   true,
			wantMin:  floatPtr(10.0),
			wantMax:  floatPtr(12.0),
			wantSent: 2,
			wantLost: 0,
			wantN:    2,
		},
		{
			name: "无效输出",
			output: `invalid ping output
nothing useful here`,
			wantOK: false,
			wantN:  -1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parsePingOutput(tt.output)

			if ok != tt.wantOK {
				t.Fatalf("parsePingOutput() ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if tt.wantRTT != nil && !equalFloatPtr(got.Avg, tt.wantRTT) {
				t.Errorf("avg = %v, want %v", formatFloatPtr(got.Avg), formatFloatPtr(tt.wantRTT))
			}
			if !equalFloatPtr(got.Min, tt.wantMin) {
				t.Errorf("min = %v, want %v", formatFloatPtr(got.Min), formatFloatPtr(tt.wantMin))
			}
			if !equalFloatPtr(got.Max, tt.wantMax) {
				t.Errorf("max = %v, want %v", formatFloatPtr(got.Max), formatFloatPtr(tt.wantMax))
			}
			if tt.wantMdev != nil && !equalFloatPtr(got.Mdev, tt.wantMdev) {
				t.Errorf("mdev = %v, want %v", formatFloatPtr(got.Mdev), formatFloatPtr(tt.wantMdev))
			}
			if got.Sent != tt.wantSent {
				t.Errorf("sent = %v, want %v", got.Sent, tt.wantSent)
			}
			if got.Lost != tt.wantLost {
				t.Errorf("lost = %v, want %v", got.Lost, tt.wantLost)
			}
			if tt.wantN >= 0 && len(got.RTTs) != tt.wantN {
				t.Errorf("samples = %d, want %d", len(got.RTTs), tt.wantN)
			}
		})
	}
}

func TestMergeSummaries_FromSamples(t *testing.T) {
	a := summarizeSamples([]float64{10, 12, 11}, 3, 0)
	b := summarizeSamples([]float64{20, 40}, 3, 1)
	got := mergeSummaries([]LatencySummary{a, b})
	if got.Sent != 6 || got.Lost != 1 || got.Recv != 5 {
		t.Fatalf("sent/lost/recv = %d/%d/%d, want 6/1/5", got.Sent, got.Lost, got.Recv)
	}
	if got.Min == nil || *got.Min != 10 {
		t.Errorf("min = %v, want 10", formatFloatPtr(got.Min))
	}
	if got.Max == nil || *got.Max != 40 {
		t.Errorf("max = %v, want 40", formatFloatPtr(got.Max))
	}
	// 5 包 P95 = max
	if got.P95 == nil || *got.P95 != 40 {
		t.Errorf("p95 = %v, want 40", formatFloatPtr(got.P95))
	}
	if got.Avg == nil || math.Abs(*got.Avg-18.6) > 0.001 {
		t.Errorf("avg = %v, want 18.6", formatFloatPtr(got.Avg))
	}
}

func TestMergeSummaries_LegacyNoSamples(t *testing.T) {
	avg := 30.0
	min := 25.0
	mdev := 2.0
	got := mergeSummaries([]LatencySummary{
		{Avg: &avg, Min: &min, Mdev: &mdev, Sent: 10, Lost: 0},
		{Avg: &avg, Min: &min, Mdev: &mdev, Sent: 10, Lost: 0},
	})
	if got.Recv != 20 || got.Avg == nil || math.Abs(*got.Avg-30) > 0.001 {
		t.Errorf("legacy 加权平均失败: recv=%d avg=%v", got.Recv, formatFloatPtr(got.Avg))
	}
	if got.P95 != nil {
		t.Errorf("无逐包样本时 P95 应留空, got %v", formatFloatPtr(got.P95))
	}
	// 旧行没有 max_rtt，就该留空让前端显示 --；拿分钟均值冒充实测最大值
	// 等于把「不知道」谎报成一个具体读数
	if got.Max != nil {
		t.Errorf("旧行无 max_rtt 时应留空, got %v", formatFloatPtr(got.Max))
	}
}

func TestQueryLatencyPoints_BucketsAndWindow(t *testing.T) {
	db, err := storage.NewDB(t.TempDir())
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	defer db.Close()
	c := &Collector{db: db}

	a := summarizeSamples([]float64{10, 12, 11, 13, 14}, 5, 0)
	b := summarizeSamples([]float64{20, 100}, 2, 0)
	if err := c.insertLatency(100, "1.1.1.1", a); err != nil {
		t.Fatalf("insert a: %v", err)
	}
	if err := c.insertLatency(400, "1.1.1.1", b); err != nil {
		t.Fatalf("insert b: %v", err)
	}

	// 1 秒粒度：两点，各带 rtts
	pts, window, err := QueryLatencyPoints(db, "1.1.1.1", 0, 1000, 1)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(pts) != 2 {
		t.Fatalf("points = %d, want 2", len(pts))
	}
	if len(pts[0].RTTs) != 5 || len(pts[1].RTTs) != 2 {
		t.Errorf("rtts len = %d, %d", len(pts[0].RTTs), len(pts[1].RTTs))
	}
	if window.Max == nil || *window.Max != 100 || window.P95 == nil || *window.P95 != 100 {
		t.Errorf("window max/p95 = %v %v, want 100 100", window.Max, window.P95)
	}

	// 600 秒粒度：合成一桶，样本 7 个仍低于上限，JSON 仍带 rtts
	pts, _, err = QueryLatencyPoints(db, "1.1.1.1", 0, 1000, 600)
	if err != nil {
		t.Fatalf("query 600: %v", err)
	}
	if len(pts) != 1 {
		t.Fatalf("600s 桶数 = %d, want 1", len(pts))
	}
	if pts[0].Max == nil || *pts[0].Max != 100 {
		t.Errorf("桶 max = %v, want 100", pts[0].Max)
	}
	if len(pts[0].RTTs) != 7 {
		t.Errorf("合桶后仍应带 7 个样本, got %d", len(pts[0].RTTs))
	}
}

func TestParsePingOutput_EdgeCases(t *testing.T) {
	output := `5 packets transmitted, 6 received, -20% packet loss`
	got, ok := parsePingOutput(output)
	if !ok {
		t.Fatal("有统计行应解析成功")
	}
	if got.Lost != 0 {
		t.Errorf("lost 应为 0（接收数 > 发送数），实际 = %d", got.Lost)
	}
	if got.Sent != 5 {
		t.Errorf("sent 应为 5，实际 = %d", got.Sent)
	}
	if got.Avg != nil {
		t.Errorf("无 RTT 行不应解析出 RTT，实际 = %v", formatFloatPtr(got.Avg))
	}
}

func equalFloatPtr(a, b *float64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return math.Abs(*a-*b) < 0.001
}

func formatFloatPtr(f *float64) string {
	if f == nil {
		return "nil"
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", *f), "0"), ".")
}
