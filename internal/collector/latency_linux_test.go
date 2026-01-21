package collector

import (
	"fmt"
	"strings"
	"testing"
)

// TestParsePingOutput 测试 ping 输出解析
func TestParsePingOutput(t *testing.T) {
	tests := []struct {
		name          string
		output        string
		expectedCount int
		wantRTT       *float64
		wantSent      int
		wantLost      int
	}{
		{
			name: "正常输出",
			output: `PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 4005ms
rtt min/avg/max/mdev = 10.123/15.456/20.789/3.214 ms`,
			expectedCount: 5,
			wantRTT:       floatPtr(15.456),
			wantSent:      5,
			wantLost:      0,
		},
		{
			name: "部分丢包",
			output: `--- 8.8.8.8 ping statistics ---
5 packets transmitted, 3 received, 40% packet loss, time 4005ms
rtt min/avg/max/mdev = 10.0/12.5/15.0/2.5 ms`,
			expectedCount: 5,
			wantRTT:       floatPtr(12.5),
			wantSent:      5,
			wantLost:      2,
		},
		{
			name: "全部丢包",
			output: `--- 192.168.99.99 ping statistics ---
5 packets transmitted, 0 received, 100% packet loss, time 4090ms`,
			expectedCount: 5,
			wantRTT:       nil,
			wantSent:      5,
			wantLost:      5,
		},
		{
			name: "旧版 ping 格式 (stddev)",
			output: `--- 1.1.1.1 ping statistics ---
10 packets transmitted, 10 received, 0% packet loss, time 9010ms
rtt min/avg/max/stddev = 8.000/10.500/12.000/1.234 ms`,
			expectedCount: 10,
			wantRTT:       floatPtr(10.500),
			wantSent:      10,
			wantLost:      0,
		},
		{
			name: "无效输出",
			output: `invalid ping output
nothing useful here`,
			expectedCount: 5,
			wantRTT:       nil,
			wantSent:      5,
			wantLost:      5,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRTT, gotSent, gotLost := parsePingOutput(tt.output, tt.expectedCount)

			if !equalFloatPtr(gotRTT, tt.wantRTT) {
				t.Errorf("parsePingOutput() gotRTT = %v, want %v", formatFloatPtr(gotRTT), formatFloatPtr(tt.wantRTT))
			}
			if gotSent != tt.wantSent {
				t.Errorf("parsePingOutput() gotSent = %v, want %v", gotSent, tt.wantSent)
			}
			if gotLost != tt.wantLost {
				t.Errorf("parsePingOutput() gotLost = %v, want %v", gotLost, tt.wantLost)
			}
		})
	}
}

// TestParsePingOutput_EdgeCases 边界测试
func TestParsePingOutput_EdgeCases(t *testing.T) {
	// 测试接收数大于发送数（异常情况）
	output := `5 packets transmitted, 6 received, -20% packet loss`
	rtt, sent, lost := parsePingOutput(output, 5)
	if lost != 0 {
		t.Errorf("lost 应为 0（接收数 > 发送数），实际 = %d", lost)
	}
	if sent != 5 {
		t.Errorf("sent 应为 5，实际 = %d", sent)
	}
	if rtt != nil {
		t.Log("警告：无 RTT 数据但解析成功，可能是正则过于宽松")
	}
}

// 辅助函数
func floatPtr(f float64) *float64 {
	return &f
}

func equalFloatPtr(a, b *float64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	diff := *a - *b
	if diff < 0 {
		diff = -diff
	}
	return diff < 0.001 // 允许浮点误差
}

func formatFloatPtr(f *float64) string {
	if f == nil {
		return "nil"
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", *f), "0"), ".")
}
