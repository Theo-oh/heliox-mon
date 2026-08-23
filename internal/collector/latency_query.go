package collector

import (
	"database/sql"

	"github.com/hh/heliox-mon/internal/storage"
)

// 单个时间桶最多把这么多个成功包塞进 JSON。超过说明粒度已经合并了多轮探测，
// 前端用桶摘要做缩放统计，不再拉整段原始样本。
const maxRTTsPerPoint = 40

// LatencyPoint 是 API / 前端用的一个时间桶。
type LatencyPoint struct {
	TS     int64
	Avg    *float64
	Min    *float64
	Max    *float64
	P95    *float64
	Jitter *float64
	Sent   int
	Lost   int
	Recv   int
	SumRTT float64
	SumSq  float64
	RTTs   []float64
}

// QueryLatencyPoints 读取 [startTs, endTs] 内某目标的记录，按 granSec 分桶合并。
// window 是整段窗口用同一套规则算出的摘要（有逐包时 P95 为真包级）。
func QueryLatencyPoints(db *storage.DB, target string, startTs, endTs, granSec int64) ([]LatencyPoint, LatencySummary, error) {
	if granSec < 1 {
		granSec = 1
	}
	rows, err := db.Query(`
		SELECT ts, rtt_ms, min_rtt, mdev, sent, lost,
		       max_rtt, p95_rtt, sum_rtt, sum_sq, recv, rtts
		FROM latency_records
		WHERE target = ? AND ts >= ? AND ts <= ?
		ORDER BY ts
	`, target, startTs, endTs)
	if err != nil {
		return nil, LatencySummary{}, err
	}
	defer rows.Close()

	buckets := make(map[int64][]LatencySummary)
	var order []int64
	var all []LatencySummary
	for rows.Next() {
		s, ts, err := scanLatencyRow(rows)
		if err != nil {
			return nil, LatencySummary{}, err
		}
		all = append(all, s)
		b := (ts / granSec) * granSec
		if _, ok := buckets[b]; !ok {
			order = append(order, b)
		}
		buckets[b] = append(buckets[b], s)
	}
	if err := rows.Err(); err != nil {
		return nil, LatencySummary{}, err
	}

	points := make([]LatencyPoint, 0, len(order))
	for _, ts := range order {
		points = append(points, summaryToPoint(ts, mergeSummaries(buckets[ts])))
	}
	return points, mergeSummaries(all), nil
}

func scanLatencyRow(rows *sql.Rows) (LatencySummary, int64, error) {
	var ts int64
	var rtt, minRtt, mdev, maxRtt, p95, sumRtt, sumSq sql.NullFloat64
	var sent, lost, recv sql.NullInt64
	var rtts sql.NullString
	if err := rows.Scan(&ts, &rtt, &minRtt, &mdev, &sent, &lost,
		&maxRtt, &p95, &sumRtt, &sumSq, &recv, &rtts); err != nil {
		return LatencySummary{}, 0, err
	}
	return scanLatencySummary(rtt, minRtt, mdev, maxRtt, p95, sumRtt, sumSq, sent, lost, recv, rtts), ts, nil
}

func summaryToPoint(ts int64, s LatencySummary) LatencyPoint {
	p := LatencyPoint{
		TS:     ts,
		Avg:    s.Avg,
		Min:    s.Min,
		Max:    s.Max,
		P95:    s.P95,
		Jitter: s.Mdev,
		Sent:   s.Sent,
		Lost:   s.Lost,
		Recv:   s.Recv,
		SumRTT: s.SumRTT,
		SumSq:  s.SumSq,
	}
	if n := len(s.RTTs); n > 0 && n <= maxRTTsPerPoint {
		p.RTTs = s.RTTs
	}
	return p
}

// SummarizeLatencyRange 窗口级摘要，区间为 [startTs, endExclusive)，供日报使用。
func SummarizeLatencyRange(db *storage.DB, target string, startTs, endExclusive int64) (LatencySummary, error) {
	if endExclusive <= startTs {
		return LatencySummary{}, nil
	}
	_, window, err := QueryLatencyPoints(db, target, startTs, endExclusive-1, 1)
	return window, err
}
