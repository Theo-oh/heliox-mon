package storage

import (
	"testing"
)

// TestNewDBAndMigrate 验证数据库可正常初始化、迁移幂等、关键表可读写。
func TestNewDBAndMigrate(t *testing.T) {
	dir := t.TempDir()

	db, err := NewDB(dir)
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	defer db.Close()

	// 迁移应幂等：在同一目录再次打开不应报错
	db2, err := NewDB(dir)
	if err != nil {
		t.Fatalf("二次 NewDB（幂等迁移）失败: %v", err)
	}
	db2.Close()

	// 关键表应存在
	for _, table := range []string{"traffic_snapshots", "traffic_daily", "port_traffic_snapshots"} {
		var name string
		err := db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table,
		).Scan(&name)
		if err != nil {
			t.Errorf("期望表 %q 存在，查询失败: %v", table, err)
		}
	}
}

// TestTrafficSnapshotRoundtrip 验证 stats 接口依赖的 MAX-MIN 当日流量查询逻辑。
func TestTrafficSnapshotRoundtrip(t *testing.T) {
	dir := t.TempDir()
	db, err := NewDB(dir)
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	defer db.Close()

	rows := []struct {
		ts       int64
		txB, rxB int64
	}{
		{100, 1000, 5000},
		{200, 1500, 5200},
		{300, 3000, 9000},
	}
	for _, r := range rows {
		if _, err := db.Exec(
			`INSERT INTO traffic_snapshots (ts, iface, tx_bytes, rx_bytes) VALUES (?, 'total', ?, ?)`,
			r.ts, r.txB, r.rxB,
		); err != nil {
			t.Fatalf("插入快照失败: %v", err)
		}
	}

	var tx, rx int64
	err = db.QueryRow(`
		SELECT COALESCE(MAX(tx_bytes) - MIN(tx_bytes), 0),
		       COALESCE(MAX(rx_bytes) - MIN(rx_bytes), 0)
		FROM traffic_snapshots
		WHERE iface = 'total' AND ts >= ? AND ts <= ?
	`, int64(100), int64(300)).Scan(&tx, &rx)
	if err != nil {
		t.Fatalf("查询当日流量失败: %v", err)
	}
	if tx != 2000 { // 3000 - 1000
		t.Errorf("tx = %d, want 2000", tx)
	}
	if rx != 4000 { // 9000 - 5000
		t.Errorf("rx = %d, want 4000", rx)
	}
}

func TestLatencyRecordNewColumns(t *testing.T) {
	db, err := NewDB(t.TempDir())
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`INSERT INTO latency_records
		(ts, target, rtt_ms, min_rtt, mdev, sent, lost, is_aggregated,
		 max_rtt, p95_rtt, sum_rtt, sum_sq, recv, rtts)
		VALUES (1, '1.1.1.1', 13.2, 10, 3.5, 5, 0, 0, 20, 20, 66, 900, 5, '[10,12,11,20,13]')`)
	if err != nil {
		t.Fatalf("插入含新列的延迟记录失败: %v", err)
	}

	var maxRtt, p95, sumRtt, sumSq float64
	var recv int
	var rtts string
	if err := db.QueryRow(`SELECT max_rtt, p95_rtt, sum_rtt, sum_sq, recv, rtts FROM latency_records`).
		Scan(&maxRtt, &p95, &sumRtt, &sumSq, &recv, &rtts); err != nil {
		t.Fatalf("读回新列失败: %v", err)
	}
	if maxRtt != 20 || p95 != 20 || recv != 5 || rtts != "[10,12,11,20,13]" {
		t.Errorf("max=%v p95=%v recv=%d rtts=%q", maxRtt, p95, recv, rtts)
	}
}
