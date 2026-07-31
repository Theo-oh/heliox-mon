package collector

import "testing"

func TestParseCPUStatLine(t *testing.T) {
	// 字段顺序：cpu user nice system idle iowait irq softirq steal guest guest_nice
	tests := []struct {
		name  string
		line  string
		want  cpuTimes
		wantK bool
	}{
		{
			name: "完整行",
			line: "cpu  100 20 50 800 30 5 5 10 0 0",
			// total 只累加到 steal：100+20+50+800+30+5+5+10 = 1020
			want:  cpuTimes{total: 1020, idle: 830, steal: 10},
			wantK: true,
		},
		{
			name: "guest 与 guest_nice 不重复累加",
			// guest=40 已包含在 user=100 内，guest_nice=7 已包含在 nice=20 内，
			// total 应与上一用例完全一致
			line:  "cpu  100 20 50 800 30 5 5 10 40 7",
			want:  cpuTimes{total: 1020, idle: 830, steal: 10},
			wantK: true,
		},
		{
			name: "iowait 计入空闲",
			// idle=800 + iowait=30，忙碌部分应为 100+20+50+5+5+10 = 190
			line:  "cpu  100 20 50 800 30 5 5 10",
			want:  cpuTimes{total: 1020, idle: 830, steal: 10},
			wantK: true,
		},
		{
			name:  "缺少 steal 的旧内核",
			line:  "cpu  100 20 50 800 30 5 5",
			want:  cpuTimes{total: 1010, idle: 830, steal: 0},
			wantK: true,
		},
		{
			name:  "字段不足",
			line:  "cpu  100 20 50 800",
			wantK: false,
		},
		{
			name:  "非 cpu 汇总行",
			line:  "cpu0 100 20 50 800 30 5 5 10",
			wantK: false,
		},
		{
			name:  "字段非法时整行丢弃",
			line:  "cpu  100 20 abc 800 30 5 5 10",
			wantK: false,
		},
		{
			name:  "空行",
			line:  "",
			wantK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseCPUStatLine(tt.line)
			if ok != tt.wantK {
				t.Fatalf("parseCPUStatLine(%q) ok = %v, 期望 %v", tt.line, ok, tt.wantK)
			}
			if !tt.wantK {
				return
			}
			if got != tt.want {
				t.Errorf("parseCPUStatLine(%q) = %+v, 期望 %+v", tt.line, got, tt.want)
			}
		})
	}
}

// TestCPUUsageExcludesIowaitAndSteal 验证按解析结果算出的使用率把 iowait 归为空闲、
// 并能单独还原出 steal 占比
func TestCPUUsageExcludesIowaitAndSteal(t *testing.T) {
	prev, ok := parseCPUStatLine("cpu  0 0 0 0 0 0 0 0")
	if !ok {
		t.Fatal("解析基准行失败")
	}
	// 本轮新增：user 100、idle 700、iowait 100、steal 100，合计 1000
	cur, ok := parseCPUStatLine("cpu  100 0 0 700 100 0 0 100")
	if !ok {
		t.Fatal("解析当前行失败")
	}

	deltaTotal := float64(cur.total - prev.total)
	usage := 100 * (deltaTotal - float64(cur.idle-prev.idle)) / deltaTotal
	steal := 100 * float64(cur.steal-prev.steal) / deltaTotal

	// 800 jiffies 空闲（idle+iowait）→ 使用率 20%，其中 10% 是被宿主机抢走的
	if usage != 20 {
		t.Errorf("使用率 = %v, 期望 20（iowait 应算作空闲）", usage)
	}
	if steal != 10 {
		t.Errorf("steal 占比 = %v, 期望 10", steal)
	}
}

func TestClampPercent(t *testing.T) {
	cases := map[float64]float64{
		-0.5:  0,
		0:     0,
		42.5:  42.5,
		100:   100,
		100.3: 100,
	}
	for in, want := range cases {
		if got := clampPercent(in); got != want {
			t.Errorf("clampPercent(%v) = %v, 期望 %v", in, got, want)
		}
	}
}
