package collector

import "testing"

func TestParseHexPort(t *testing.T) {
	tests := []struct {
		addr string
		want uint64
		ok   bool
	}{
		{"0100007F:1F90", 8080, true},                         // IPv4，端口 0x1F90
		{"00000000:01BB", 443, true},                          // 监听 0.0.0.0:443
		{"00000000000000000000000000000000:2329", 9001, true}, // IPv6 全零地址
		{"0100007F", 0, false},                                // 缺少端口
		{"0100007F:ZZZZ", 0, false},                           // 端口非十六进制
	}

	for _, tt := range tests {
		got, ok := parseHexPort(tt.addr)
		if ok != tt.ok {
			t.Errorf("parseHexPort(%q) ok = %v, 期望 %v", tt.addr, ok, tt.ok)
			continue
		}
		if ok && got != tt.want {
			t.Errorf("parseHexPort(%q) = %d, 期望 %d", tt.addr, got, tt.want)
		}
	}
}

func TestParseTCPSnmp(t *testing.T) {
	header := "Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors"
	values := "Tcp: 1 200 120000 -1 1000 2000 3 4 5 60000 70000 350 0 12 0"

	got, ok := parseTCPSnmp(header, values)
	if !ok {
		t.Fatal("parseTCPSnmp 返回 ok = false，期望解析成功")
	}
	if got.outSegs != 70000 {
		t.Errorf("outSegs = %d, 期望 70000", got.outSegs)
	}
	if got.retransSegs != 350 {
		t.Errorf("retransSegs = %d, 期望 350", got.retransSegs)
	}
}

// TestParseTCPSnmpColumnOrder 字段按名定位，列顺序变化不应导致取错值
func TestParseTCPSnmpColumnOrder(t *testing.T) {
	got, ok := parseTCPSnmp("Tcp: RetransSegs OutSegs", "Tcp: 350 70000")
	if !ok {
		t.Fatal("parseTCPSnmp 返回 ok = false，期望解析成功")
	}
	if got.outSegs != 70000 || got.retransSegs != 350 {
		t.Errorf("按列名取值失败: %+v", got)
	}
}

func TestParseTCPSnmpInvalid(t *testing.T) {
	tests := []struct {
		name           string
		header, values string
	}{
		{"表头与数值列数不符", "Tcp: OutSegs RetransSegs", "Tcp: 100"},
		{"缺少 RetransSegs", "Tcp: OutSegs InSegs", "Tcp: 100 200"},
		{"缺少 OutSegs", "Tcp: RetransSegs InSegs", "Tcp: 10 200"},
		{"数值非法", "Tcp: OutSegs RetransSegs", "Tcp: 100 abc"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, ok := parseTCPSnmp(tt.header, tt.values); ok {
				t.Errorf("parseTCPSnmp(%q, %q) ok = true, 期望 false", tt.header, tt.values)
			}
		})
	}
}
