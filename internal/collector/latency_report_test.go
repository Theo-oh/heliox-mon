package collector

import (
	"database/sql"
	"testing"
	"time"

	"github.com/hh/heliox-mon/internal/config"
	"github.com/hh/heliox-mon/internal/storage"
)

// TestAggregateLatencyData_ClientTarget 验证客户端上报目标（client:*）与服务端 ping
// 目标一样被 aggregateLatencyData 降采样，无需任何特殊处理（GROUP BY target 泛化）。
func TestAggregateLatencyData_ClientTarget(t *testing.T) {
	db, err := storage.NewDB(t.TempDir())
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	defer db.Close()

	c := &Collector{cfg: &config.Config{Timezone: time.UTC}, db: db}

	// 插入 8 天前的客户端原始记录（早于 7 天原始保留期，应被降采样）
	old := time.Now().Add(-8 * 24 * time.Hour).Unix()
	for i := int64(0); i < 3; i++ {
		if _, err := db.Exec(
			`INSERT INTO latency_records (ts, target, rtt_ms, min_rtt, mdev, sent, lost, is_aggregated)
			 VALUES (?, 'client:home-mac', 30, 25, 2, 10, 0, 0)`,
			old+i,
		); err != nil {
			t.Fatalf("插入原始记录失败: %v", err)
		}
	}

	c.aggregateLatencyData()

	var aggCount, rawCount int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM latency_records WHERE target='client:home-mac' AND is_aggregated=1`,
	).Scan(&aggCount); err != nil {
		t.Fatalf("查询聚合行失败: %v", err)
	}
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM latency_records WHERE target='client:home-mac' AND is_aggregated=0`,
	).Scan(&rawCount); err != nil {
		t.Fatalf("查询原始行失败: %v", err)
	}

	if aggCount != 1 {
		t.Errorf("应生成 1 条 10 分钟桶聚合行, got %d", aggCount)
	}
	if rawCount != 0 {
		t.Errorf("原始记录应已被清理, got %d", rawCount)
	}
}

func TestAggregateLatencyData_PacketP95ThenDropRTTs(t *testing.T) {
	db, err := storage.NewDB(t.TempDir())
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	defer db.Close()

	c := &Collector{cfg: &config.Config{Timezone: time.UTC}, db: db}
	old := time.Now().Add(-8 * 24 * time.Hour).Unix()
	// 钉在桶头，避免 +30s 跨过 10 分钟边界被拆成两个桶
	old = (old / latencyAggBucketSec) * latencyAggBucketSec

	a := summarizeSamples([]float64{10, 11, 12, 13, 14}, 5, 0)
	b := summarizeSamples([]float64{20, 30, 40, 50, 100}, 5, 0)
	if err := c.insertLatency(old, "1.1.1.1", a); err != nil {
		t.Fatalf("插入 a 失败: %v", err)
	}
	if err := c.insertLatency(old+30, "1.1.1.1", b); err != nil {
		t.Fatalf("插入 b 失败: %v", err)
	}

	c.aggregateLatencyData()

	var p95, max float64
	var rtts sql.NullString
	var recv, agg int
	if err := db.QueryRow(`
		SELECT p95_rtt, max_rtt, recv, rtts, is_aggregated
		FROM latency_records WHERE target='1.1.1.1'`).
		Scan(&p95, &max, &recv, &rtts, &agg); err != nil {
		t.Fatalf("读聚合行失败: %v", err)
	}
	if agg != 1 {
		t.Errorf("is_aggregated = %d, want 1", agg)
	}
	if rtts.Valid {
		t.Errorf("聚合后 rtts 应丢掉, got %q", rtts.String)
	}
	if recv != 10 {
		t.Errorf("recv = %d, want 10", recv)
	}
	if max != 100 {
		t.Errorf("max = %v, want 100", max)
	}
	// 10 包 10..100，ceil(0.95*10)=10 → P95 = 100
	if p95 != 100 {
		t.Errorf("p95 = %v, want 100（10 包近邻秩）", p95)
	}

	// 再跑一轮不得重复插入
	c.aggregateLatencyData()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM latency_records WHERE target='1.1.1.1'`).Scan(&n); err != nil {
		t.Fatalf("计数失败: %v", err)
	}
	if n != 1 {
		t.Errorf("幂等降采样后行数 = %d, want 1", n)
	}
}
