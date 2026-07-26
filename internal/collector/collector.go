// Package collector 数据采集器
package collector

import (
	"log"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hh/heliox-mon/internal/config"
	"github.com/hh/heliox-mon/internal/storage"
)

// Collector 数据采集器
type Collector struct {
	cfg      *config.Config
	db       *storage.DB
	notifier Notifier
	stop     chan struct{}
	wg       sync.WaitGroup

	// 上次采集的流量数据（用于计算增量）。总量字段用原子类型：
	// 实时网速协程（每秒）与流量采集协程（每分钟）会并发访问，
	// 端口相关的 map 只在流量采集协程内使用，无需同步
	lastTotalTx atomic.Uint64
	lastTotalRx atomic.Uint64
	lastPortTx  map[int]uint64
	lastPortRx  map[int]uint64

	// 计数器重置偏移量（用于处理重启/溢出）
	totalTxOffset atomic.Uint64
	totalRxOffset atomic.Uint64
	portTxOffset  map[int]uint64
	portRxOffset  map[int]uint64

	// CPU 采样（用于计算实时使用率）
	lastCPUTotal uint64
	lastCPUIdle  uint64

	// 实时快照（每秒更新，用于计算实时网速）
	realtimeSnapshot RealtimeSnapshot
	realtimeMu       sync.RWMutex

	// 上次清理系统指标的时间（只在系统采集协程内读写）
	lastMetricsCleanup time.Time
}

// RealtimeSnapshot 实时流量快照
type RealtimeSnapshot struct {
	Ts      int64
	TxBytes uint64
	RxBytes uint64
	TxSpeed float64 // bytes/s
	RxSpeed float64 // bytes/s
}

// Notifier 通知器接口
type Notifier interface {
	SendTrafficAlert(usedGB, limitGB int, percent float64, resetDate string, daysLeft int, threshold int) error
	SendDailyReport() error
}

// New 创建采集器
func New(cfg *config.Config, db *storage.DB, notifier Notifier) *Collector {
	return &Collector{
		cfg:          cfg,
		db:           db,
		notifier:     notifier,
		stop:         make(chan struct{}),
		lastPortTx:   make(map[int]uint64),
		lastPortRx:   make(map[int]uint64),
		portTxOffset: make(map[int]uint64),
		portRxOffset: make(map[int]uint64),
	}
}

// GetRealtimeSnapshot 获取实时快照
func (c *Collector) GetRealtimeSnapshot() RealtimeSnapshot {
	c.realtimeMu.RLock()
	defer c.realtimeMu.RUnlock()
	return c.realtimeSnapshot
}

// GetRealtimeSpeed 获取实时网速（供 API 使用）
func (c *Collector) GetRealtimeSpeed() (txSpeed, rxSpeed float64, ts int64) {
	c.realtimeMu.RLock()
	defer c.realtimeMu.RUnlock()
	return c.realtimeSnapshot.TxSpeed, c.realtimeSnapshot.RxSpeed, c.realtimeSnapshot.Ts
}

// Start 启动采集器
func (c *Collector) Start() {
	// 初始化计数器偏移量，避免重启导致统计跳变
	c.initTrafficOffsets()

	// 系统资源采集（每 5 秒）
	c.wg.Add(1)
	go c.collectSystemMetrics()

	// 流量采集写入数据库（每 1 分钟）
	c.wg.Add(1)
	go c.collectTraffic()

	// 实时网速采集（每 1 秒，只更新内存）
	c.wg.Add(1)
	go c.collectRealtimeSpeed()

	// 延迟监控（每 1 分钟）
	c.wg.Add(1)
	go c.collectLatency()

	// 日汇总任务（每分钟检查一次）
	c.wg.Add(1)
	go c.runDailyAggregation()

	// 每日流量报告（需显式开启且配好 Telegram）
	if c.notifier != nil && c.cfg.DailyReportEnabled {
		if c.cfg.TelegramBotToken == "" || c.cfg.TelegramChatID == "" {
			log.Println("警告: DAILY_REPORT_ENABLED=true 但未配置 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID，每日报告将不会发送")
		}
		c.wg.Add(1)
		go c.runDailyReport()
	}

	log.Println("采集器已启动")
}

// Stop 停止采集器
func (c *Collector) Stop() {
	close(c.stop)
	c.wg.Wait()
	log.Println("采集器已停止")
}

// collectSystemMetrics 采集系统资源
func (c *Collector) collectSystemMetrics() {
	defer c.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.doCollectSystemMetrics()
		}
	}
}

// collectTraffic 采集流量
func (c *Collector) collectTraffic() {
	defer c.wg.Done()
	ticker := time.NewTicker(1 * time.Minute) // 每分钟写入数据库，避免锁定
	defer ticker.Stop()

	// 初始采集
	c.doCollectTraffic()

	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.doCollectTraffic()
		}
	}
}

// collectLatency 采集延迟
func (c *Collector) collectLatency() {
	defer c.wg.Done()
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.doCollectLatency()
		}
	}
}

// runDailyAggregation 运行日汇总任务
func (c *Collector) runDailyAggregation() {
	defer c.wg.Done()

	// 延迟执行首次汇总，避免与其他 goroutine 初始化并发导致 SQLite 锁冲突
	time.Sleep(3 * time.Second)
	c.doDailyAggregation()

	ticker := time.NewTicker(1 * time.Minute) // 每分钟更新日汇总
	defer ticker.Stop()

	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.doDailyAggregation()
		}
	}
}

// runDailyReport 每天在配置的整点推送一次流量报告。
// 用定时器对齐到「下一个触发时刻」而非每分钟轮询：重启后会重新计算下一次，
// 因此进程重启不会重复推送（session 同样存内存，与项目现状一致）。
func (c *Collector) runDailyReport() {
	defer c.wg.Done()

	// base 是推算下一次推送的基准时刻。推送后取「本次目标时刻」与「当前时刻」的较晚者：
	// 若时钟回拨导致唤醒时 now 仍早于目标整点，用 now 会把同一整点再算成下一次而重复推送
	base := time.Now().In(c.cfg.Timezone)
	for {
		next := nextReportTime(base, c.cfg.DailyReportHour, c.cfg.Timezone)
		log.Printf("每日流量报告下次推送时间: %s", next.Format("2006-01-02 15:04:05 MST"))
		timer := time.NewTimer(time.Until(next))
		select {
		case <-c.stop:
			timer.Stop()
			return
		case <-timer.C:
			if err := c.notifier.SendDailyReport(); err != nil {
				log.Printf("发送每日流量报告失败: %v", err)
			} else {
				log.Println("每日流量报告已推送")
			}
			base = next
			if now := time.Now().In(c.cfg.Timezone); now.After(base) {
				base = now
			}
		}
	}
}

// nextReportTime 计算 now 之后下一个 hour 整点（按 tz）
func nextReportTime(now time.Time, hour int, tz *time.Location) time.Time {
	next := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, tz)
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

// doDailyAggregation 执行日汇总
func (c *Collector) doDailyAggregation() {
	now := time.Now().In(c.cfg.Timezone)
	today := now.Format("2006-01-02")
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")

	// 汇总整体流量（今日 + 昨日）
	c.aggregateDailyTraffic(today)
	c.aggregateDailyTraffic(yesterday)

	// 汇总端口流量（今日 + 昨日）
	c.aggregatePortDailyTraffic(today)
	c.aggregatePortDailyTraffic(yesterday)

	// 汇总延迟数据（降采样）
	c.aggregateLatencyData()

	// 清理过期快照
	c.cleanupOldSnapshots()

	// 检查配额并发送通知
	c.checkQuotaAndNotify(now)
}

func (c *Collector) dayBounds(date string) (int64, int64, bool) {
	start, err := time.ParseInLocation("2006-01-02", date, c.cfg.Timezone)
	if err != nil {
		return 0, 0, false
	}
	end := start.Add(24*time.Hour - time.Second)
	return start.Unix(), end.Unix(), true
}

// aggregateDailyTraffic 汇总每日整体流量
func (c *Collector) aggregateDailyTraffic(date string) {
	startTs, endTs, ok := c.dayBounds(date)
	if !ok {
		return
	}

	// 获取当天的流量增量
	row := c.db.QueryRow(`
		SELECT MAX(tx_bytes) - MIN(tx_bytes), MAX(rx_bytes) - MIN(rx_bytes)
		FROM traffic_snapshots
		WHERE iface = 'total'
		  AND ts >= ? AND ts <= ?
	`, startTs, endTs)

	var tx, rx int64
	if err := row.Scan(&tx, &rx); err != nil || (tx <= 0 && rx <= 0) {
		return
	}

	// 插入或更新日汇总
	if _, err := c.db.Exec(`
		INSERT INTO traffic_daily (date, iface, tx_bytes, rx_bytes)
		VALUES (?, 'total', ?, ?)
		ON CONFLICT(date, iface) DO UPDATE SET tx_bytes = excluded.tx_bytes, rx_bytes = excluded.rx_bytes
	`, date, tx, rx); err != nil {
		log.Printf("写入日汇总流量失败 [%s]: %v", date, err)
	}
}

// aggregatePortDailyTraffic 汇总端口流量
func (c *Collector) aggregatePortDailyTraffic(date string) {
	startTs, endTs, ok := c.dayBounds(date)
	if !ok {
		return
	}

	ports := []int{c.cfg.SnellPort, c.cfg.VlessPort}
	for _, port := range ports {
		if port == 0 {
			continue
		}

		row := c.db.QueryRow(`
			SELECT MAX(tx_bytes) - MIN(tx_bytes), MAX(rx_bytes) - MIN(rx_bytes)
			FROM port_traffic_snapshots
			WHERE port = ?
			  AND ts >= ? AND ts <= ?
		`, port, startTs, endTs)

		var tx, rx int64
		if err := row.Scan(&tx, &rx); err != nil || (tx <= 0 && rx <= 0) {
			continue
		}

		if _, err := c.db.Exec(`
			INSERT INTO port_traffic_daily (date, port, tx_bytes, rx_bytes)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(date, port) DO UPDATE SET tx_bytes = excluded.tx_bytes, rx_bytes = excluded.rx_bytes
		`, date, port, tx, rx); err != nil {
			log.Printf("写入端口日汇总流量失败 [%s port %d]: %v", date, port, err)
		}
	}
}

// 延迟数据保留策略
const (
	latencyRawRetention = 7 * 24 * time.Hour  // 原始（每分钟）数据保留 7 天
	latencyAggRetention = 90 * 24 * time.Hour // 聚合数据保留 90 天
	latencyAggBucketSec = 600                 // 聚合粒度：10 分钟
)

// aggregateLatencyData 延迟数据降采样
// 将 7 天前的原始数据按 10 分钟桶聚合后写入（is_aggregated=1），再删除原始记录，
// 避免历史数据被直接删光——既保留长期趋势，又控制数据库体积。
func (c *Collector) aggregateLatencyData() {
	cutoff := time.Now().Add(-latencyRawRetention).Unix()

	// 1. 按 (target, 10分钟桶) 聚合 7 天前的原始数据
	// AVG/MIN 自动忽略 NULL；min_rtt 取桶内真实最小，mdev 取均值近似抖动，
	// sent/lost 求和保持丢包统计连续
	if _, err := c.db.Exec(`
		INSERT INTO latency_records (ts, target, rtt_ms, min_rtt, mdev, sent, lost, is_aggregated)
		SELECT (ts / ?) * ?,
		       target,
		       AVG(rtt_ms),
		       MIN(min_rtt),
		       AVG(mdev),
		       SUM(COALESCE(sent, 0)),
		       SUM(COALESCE(lost, 0)),
		       1
		FROM latency_records
		WHERE is_aggregated = 0 AND ts < ?
		GROUP BY target, (ts / ?)
	`, latencyAggBucketSec, latencyAggBucketSec, cutoff, latencyAggBucketSec); err != nil {
		log.Printf("延迟数据降采样失败: %v", err)
		return
	}

	// 2. 删除已聚合的原始数据
	if _, err := c.db.Exec("DELETE FROM latency_records WHERE is_aggregated = 0 AND ts < ?", cutoff); err != nil {
		log.Printf("清理延迟原始数据失败: %v", err)
	}

	// 3. 清理超过保留期的聚合数据
	aggCutoff := time.Now().Add(-latencyAggRetention).Unix()
	if _, err := c.db.Exec("DELETE FROM latency_records WHERE is_aggregated = 1 AND ts < ?", aggCutoff); err != nil {
		log.Printf("清理过期聚合数据失败: %v", err)
	}
}

// 系统指标保留策略
const (
	systemMetricsRetention     = time.Hour       // 只保留最近 1 小时
	systemMetricsCleanupPeriod = 5 * time.Minute // 清理间隔
)

// cleanupSystemMetrics 按固定间隔清理过期系统指标。
// 采集频率是 5 秒一次，若每次采集都 DELETE，会让 idx_system_metrics_ts 反复重建，
// 白白放大 WAL 写入与磁盘 IO；多留几分钟数据对查询（只取最新一条）无影响。
// 仅由系统采集协程单线程调用，故 lastMetricsCleanup 无需加锁。
func (c *Collector) cleanupSystemMetrics(now time.Time) {
	if now.Sub(c.lastMetricsCleanup) < systemMetricsCleanupPeriod {
		return
	}
	c.lastMetricsCleanup = now

	cutoff := now.Add(-systemMetricsRetention).Unix()
	if _, err := c.db.Exec("DELETE FROM system_metrics WHERE ts < ?", cutoff); err != nil {
		log.Printf("清理系统指标失败: %v", err)
	}
}

// cleanupOldSnapshots 清理过期快照
func (c *Collector) cleanupOldSnapshots() {
	// 保留从“昨日零点”开始的流量快照，确保昨日统计完整且不随时间变小
	now := time.Now().In(c.cfg.Timezone)
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, c.cfg.Timezone)
	cutoff := todayStart.AddDate(0, 0, -1).Unix()
	if _, err := c.db.Exec("DELETE FROM traffic_snapshots WHERE ts < ?", cutoff); err != nil {
		log.Printf("清理流量快照失败: %v", err)
	}
	if _, err := c.db.Exec("DELETE FROM port_traffic_snapshots WHERE ts < ?", cutoff); err != nil {
		log.Printf("清理端口流量快照失败: %v", err)
	}
}

// checkQuotaAndNotify 检查流量配额并发送通知
func (c *Collector) checkQuotaAndNotify(now time.Time) {
	if c.notifier == nil || c.cfg.MonthlyLimitGB <= 0 {
		return
	}

	billingStart, billingEnd := c.cfg.GetBillingCycleDates(now)

	// 查询本月已用流量（按 tx/rx 分开计算）
	var tx, rx int64
	row := c.db.QueryRow(`
		SELECT COALESCE(SUM(tx_bytes), 0), COALESCE(SUM(rx_bytes), 0)
		FROM traffic_daily
		WHERE date >= ? AND iface = 'total'
	`, billingStart.Format("2006-01-02"))
	if err := row.Scan(&tx, &rx); err != nil {
		log.Printf("查询计费周期流量失败: %v", err)
	}

	var usedBytes int64
	switch c.cfg.BillingMode {
	case "tx_only":
		usedBytes = tx
	case "rx_only":
		usedBytes = rx
	case "max_value":
		if tx > rx {
			usedBytes = tx
		} else {
			usedBytes = rx
		}
	default: // bidirectional
		usedBytes = tx + rx
	}

	limitGB := c.cfg.MonthlyLimitGB
	limitBytes := int64(limitGB) * 1024 * 1024 * 1024
	if limitBytes <= 0 {
		return
	}

	percent := float64(usedBytes) / float64(limitBytes) * 100
	usedGB := int(math.Round(float64(usedBytes) / float64(1024*1024*1024)))
	daysLeft := int(billingEnd.Sub(now).Hours() / 24)

	// 只就「已跨过的最高阈值」发送一条预警，避免同时触达 80/90/95 三条消息。
	// 各阈值的 24h 冷却由 notifier 基于 alert_records 独立维护，
	// 因此用量逐步攀升时仍会按 90→95 的顺序依次提醒。
	thresholds := append([]int(nil), c.cfg.AlertThresholds...)
	sort.Ints(thresholds)
	highest := -1
	for _, threshold := range thresholds {
		if threshold > 0 && percent >= float64(threshold) {
			highest = threshold
		}
	}
	if highest > 0 {
		resetDate := billingEnd.Format("2006-01-02")
		if err := c.notifier.SendTrafficAlert(usedGB, limitGB, percent, resetDate, daysLeft, highest); err != nil {
			log.Printf("发送流量预警失败: %v", err)
		}
	}
}
