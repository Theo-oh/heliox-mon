// Package collector 数据采集器
package collector

import (
	"log"
	"sync"
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

	// 上次采集的流量数据（用于计算增量）
	lastTotalTx uint64
	lastTotalRx uint64
	lastPortTx  map[int]uint64
	lastPortRx  map[int]uint64

	// 计数器重置偏移量（用于处理重启/溢出）
	totalTxOffset uint64
	totalRxOffset uint64
	portTxOffset  map[int]uint64
	portRxOffset  map[int]uint64

	// CPU 采样（用于计算实时使用率）
	lastCPUTotal uint64
	lastCPUIdle  uint64
}

// Notifier 通知器接口
type Notifier interface {
	SendTrafficAlert(usedGB, limitGB int, percent float64, resetDate string, daysLeft int) error
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

// Start 启动采集器
func (c *Collector) Start() {
	// 系统资源采集（每 5 秒）
	c.wg.Add(1)
	go c.collectSystemMetrics()

	// 流量采集（每 1 分钟）
	c.wg.Add(1)
	go c.collectTraffic()

	// 延迟监控（每 1 分钟）
	c.wg.Add(1)
	go c.collectLatency()

	// 日汇总任务（每小时检查一次）
	c.wg.Add(1)
	go c.runDailyAggregation()

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
	ticker := time.NewTicker(1 * time.Second) // 1秒采集，实时网速
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

	// 启动时立即执行一次汇总
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
