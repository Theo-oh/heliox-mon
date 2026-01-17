// Package storage SQLite 存储层
package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB 数据库封装
type DB struct {
	*sql.DB
}

// NewDB 创建数据库连接并执行迁移
func NewDB(dataDir string) (*DB, error) {
	// 确保数据目录存在
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}

	dbPath := filepath.Join(dataDir, "heliox-mon.db")
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	// 执行迁移
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("数据库迁移失败: %w", err)
	}

	return &DB{db}, nil
}

// migrate 执行数据库迁移
func migrate(db *sql.DB) error {
	migrations := []string{
		// 网络流量快照（每分钟采集）
		`CREATE TABLE IF NOT EXISTS traffic_snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			iface TEXT NOT NULL DEFAULT 'total',
			tx_bytes INTEGER NOT NULL,
			rx_bytes INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_traffic_snapshots_ts ON traffic_snapshots(ts)`,
		`CREATE INDEX IF NOT EXISTS idx_traffic_snapshots_iface ON traffic_snapshots(iface)`,

		// 端口流量快照
		`CREATE TABLE IF NOT EXISTS port_traffic_snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			port INTEGER NOT NULL,
			tx_bytes INTEGER NOT NULL,
			rx_bytes INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_port_traffic_ts ON port_traffic_snapshots(ts)`,
		`CREATE INDEX IF NOT EXISTS idx_port_traffic_port ON port_traffic_snapshots(port)`,

		// 流量日汇总
		`CREATE TABLE IF NOT EXISTS traffic_daily (
			date TEXT NOT NULL,
			iface TEXT NOT NULL DEFAULT 'total',
			tx_bytes INTEGER NOT NULL,
			rx_bytes INTEGER NOT NULL,
			PRIMARY KEY (date, iface)
		)`,

		// 端口流量日汇总
		`CREATE TABLE IF NOT EXISTS port_traffic_daily (
			date TEXT NOT NULL,
			port INTEGER NOT NULL,
			tx_bytes INTEGER NOT NULL,
			rx_bytes INTEGER NOT NULL,
			PRIMARY KEY (date, port)
		)`,

		// 延迟监控
		`CREATE TABLE IF NOT EXISTS latency_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			target TEXT NOT NULL,
			rtt_ms REAL,
			is_aggregated INTEGER DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_latency_ts ON latency_records(ts)`,
		`CREATE INDEX IF NOT EXISTS idx_latency_target ON latency_records(target)`,

		// 系统资源快照
		`CREATE TABLE IF NOT EXISTS system_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			cpu_percent REAL,
			mem_used INTEGER,
			mem_total INTEGER,
			disk_used INTEGER,
			disk_total INTEGER,
			load_1 REAL,
			load_5 REAL,
			load_15 REAL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_system_metrics_ts ON system_metrics(ts)`,

		// 报警记录（用于冷却）
		`CREATE TABLE IF NOT EXISTS alert_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			threshold INTEGER NOT NULL,
			message TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_alert_ts ON alert_records(ts)`,

		// 配置表
		`CREATE TABLE IF NOT EXISTS config (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	}

	for _, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("执行迁移失败 [%s]: %w", m[:50], err)
		}
	}

	return nil
}
