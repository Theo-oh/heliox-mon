// Package api HTTP API 服务
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/hh/heliox-mon/internal/config"
	"github.com/hh/heliox-mon/internal/storage"
)

// Server HTTP 服务器
type Server struct {
	cfg    *config.Config
	db     *storage.DB
	server *http.Server
}

// NewServer 创建服务器
func NewServer(cfg *config.Config, db *storage.DB) *Server {
	s := &Server{
		cfg: cfg,
		db:  db,
	}

	mux := http.NewServeMux()

	// API 路由
	mux.HandleFunc("/api/stats", s.basicAuth(s.handleStats))
	mux.HandleFunc("/api/system", s.basicAuth(s.handleSystem))
	mux.HandleFunc("/api/traffic/daily", s.basicAuth(s.handleTrafficDaily))
	mux.HandleFunc("/api/traffic/monthly", s.basicAuth(s.handleTrafficMonthly))
	mux.HandleFunc("/api/traffic/realtime", s.basicAuth(s.handleTrafficRealtime))
	mux.HandleFunc("/api/latency", s.basicAuth(s.handleLatency))
	mux.HandleFunc("/api/config", s.basicAuth(s.handleConfig))

	// 静态文件
	mux.HandleFunc("/", s.basicAuth(s.handleStatic))

	s.server = &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: mux,
	}

	return s
}

// Start 启动服务器
func (s *Server) Start() error {
	log.Printf("HTTP 服务启动: %s", s.cfg.ListenAddr)
	return s.server.ListenAndServe()
}

// Stop 停止服务器
func (s *Server) Stop() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.server.Shutdown(ctx)
}

// basicAuth Basic 认证中间件
func (s *Server) basicAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != s.cfg.Username || pass != s.cfg.Password {
			w.Header().Set("WWW-Authenticate", `Basic realm="Heliox Monitor"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// handleStats 仪表盘汇总数据
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	tz := s.cfg.Timezone
	now := time.Now().In(tz)
	today := now.Format("2006-01-02")
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")

	// 计算本月起止
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, tz)
	lastMonthStart := monthStart.AddDate(0, -1, 0)
	lastMonthEnd := monthStart.AddDate(0, 0, -1)

	stats := map[string]interface{}{
		"server_name":  s.cfg.ServerName,
		"timezone":     tz.String(),
		"current_time": now.Format("2006-01-02 15:04:05"),
	}

	// 今日流量
	row := s.db.QueryRow(
		"SELECT COALESCE(tx_bytes, 0), COALESCE(rx_bytes, 0) FROM traffic_daily WHERE date = ? AND iface = 'total'",
		today,
	)
	var todayTx, todayRx int64
	row.Scan(&todayTx, &todayRx)
	stats["today"] = map[string]int64{"tx": todayTx, "rx": todayRx}

	// 昨日流量
	row = s.db.QueryRow(
		"SELECT COALESCE(tx_bytes, 0), COALESCE(rx_bytes, 0) FROM traffic_daily WHERE date = ? AND iface = 'total'",
		yesterday,
	)
	var yesterdayTx, yesterdayRx int64
	row.Scan(&yesterdayTx, &yesterdayRx)
	stats["yesterday"] = map[string]int64{"tx": yesterdayTx, "rx": yesterdayRx}

	// 本月流量
	row = s.db.QueryRow(
		"SELECT COALESCE(SUM(tx_bytes), 0), COALESCE(SUM(rx_bytes), 0) FROM traffic_daily WHERE date >= ? AND iface = 'total'",
		monthStart.Format("2006-01-02"),
	)
	var monthTx, monthRx int64
	row.Scan(&monthTx, &monthRx)
	stats["this_month"] = map[string]int64{"tx": monthTx, "rx": monthRx}

	// 上月流量
	row = s.db.QueryRow(
		"SELECT COALESCE(SUM(tx_bytes), 0), COALESCE(SUM(rx_bytes), 0) FROM traffic_daily WHERE date >= ? AND date <= ? AND iface = 'total'",
		lastMonthStart.Format("2006-01-02"),
		lastMonthEnd.Format("2006-01-02"),
	)
	var lastMonthTx, lastMonthRx int64
	row.Scan(&lastMonthTx, &lastMonthRx)
	stats["last_month"] = map[string]int64{"tx": lastMonthTx, "rx": lastMonthRx}

	// 流量限额
	stats["monthly_limit_gb"] = s.cfg.MonthlyLimitGB
	stats["billing_mode"] = s.cfg.BillingMode
	stats["reset_day"] = s.cfg.ResetDay

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// handleSystem 系统资源
func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	row := s.db.QueryRow(
		"SELECT ts, cpu_percent, mem_used, mem_total, disk_used, disk_total, load_1, load_5, load_15 FROM system_metrics ORDER BY ts DESC LIMIT 1",
	)

	var ts int64
	var cpu, load1, load5, load15 float64
	var memUsed, memTotal, diskUsed, diskTotal int64

	if err := row.Scan(&ts, &cpu, &memUsed, &memTotal, &diskUsed, &diskTotal, &load1, &load5, &load15); err != nil {
		http.Error(w, "No data", http.StatusNotFound)
		return
	}

	data := map[string]interface{}{
		"ts":          ts,
		"cpu_percent": cpu,
		"mem_used":    memUsed,
		"mem_total":   memTotal,
		"disk_used":   diskUsed,
		"disk_total":  diskTotal,
		"load_1":      load1,
		"load_5":      load5,
		"load_15":     load15,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// handleTrafficDaily 每日流量
func (s *Server) handleTrafficDaily(w http.ResponseWriter, r *http.Request) {
	// 返回最近 30 天
	rows, err := s.db.Query(
		"SELECT date, tx_bytes, rx_bytes FROM traffic_daily WHERE iface = 'total' ORDER BY date DESC LIMIT 30",
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var data []map[string]interface{}
	for rows.Next() {
		var date string
		var tx, rx int64
		rows.Scan(&date, &tx, &rx)
		data = append(data, map[string]interface{}{
			"date": date,
			"tx":   tx,
			"rx":   rx,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// handleTrafficMonthly 月度汇总
func (s *Server) handleTrafficMonthly(w http.ResponseWriter, r *http.Request) {
	// 返回最近 12 个月
	rows, err := s.db.Query(`
		SELECT strftime('%Y-%m', date) as month, SUM(tx_bytes), SUM(rx_bytes)
		FROM traffic_daily
		WHERE iface = 'total'
		GROUP BY month
		ORDER BY month DESC
		LIMIT 12
	`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var data []map[string]interface{}
	for rows.Next() {
		var month string
		var tx, rx int64
		rows.Scan(&month, &tx, &rx)
		data = append(data, map[string]interface{}{
			"month": month,
			"tx":    tx,
			"rx":    rx,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// handleTrafficRealtime SSE 实时推送
func (s *Server) handleTrafficRealtime(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			// 获取最新两条快照计算网速
			rows, err := s.db.Query(
				"SELECT ts, tx_bytes, rx_bytes FROM traffic_snapshots WHERE iface = 'total' ORDER BY ts DESC LIMIT 2",
			)
			if err != nil {
				continue
			}

			var snapshots []struct {
				ts int64
				tx uint64
				rx uint64
			}
			for rows.Next() {
				var s struct {
					ts int64
					tx uint64
					rx uint64
				}
				rows.Scan(&s.ts, &s.tx, &s.rx)
				snapshots = append(snapshots, s)
			}
			rows.Close()

			if len(snapshots) < 2 {
				continue
			}

			dt := float64(snapshots[0].ts - snapshots[1].ts)
			if dt <= 0 {
				continue
			}

			txSpeed := float64(snapshots[0].tx-snapshots[1].tx) / dt
			rxSpeed := float64(snapshots[0].rx-snapshots[1].rx) / dt

			data := map[string]interface{}{
				"tx_speed": txSpeed,
				"rx_speed": rxSpeed,
				"ts":       snapshots[0].ts,
			}
			jsonData, _ := json.Marshal(data)
			w.Write([]byte("data: " + string(jsonData) + "\n\n"))
			flusher.Flush()
		}
	}
}

// handleLatency 延迟数据（支持多 target、统计信息）
func (s *Server) handleLatency(w http.ResponseWriter, r *http.Request) {
	// 默认返回最近 24 小时
	cutoff := time.Now().Add(-24 * time.Hour).Unix()

	// 返回所有 target 的数据
	result := map[string]interface{}{
		"targets": []map[string]interface{}{},
	}

	for _, pt := range s.cfg.PingTargets {
		rows, err := s.db.Query(
			"SELECT ts, rtt_ms FROM latency_records WHERE target = ? AND ts > ? ORDER BY ts",
			pt.Tag, cutoff,
		)
		if err != nil {
			continue
		}

		var points []map[string]interface{}
		var sum, min, max float64
		var count int
		min = 999999

		for rows.Next() {
			var ts int64
			var rtt *float64
			rows.Scan(&ts, &rtt)
			point := map[string]interface{}{"ts": ts}
			if rtt != nil {
				point["rtt_ms"] = *rtt
				sum += *rtt
				count++
				if *rtt < min {
					min = *rtt
				}
				if *rtt > max {
					max = *rtt
				}
			} else {
				point["rtt_ms"] = nil
			}
			points = append(points, point)
		}
		rows.Close()

		avg := 0.0
		if count > 0 {
			avg = sum / float64(count)
		}
		if min == 999999 {
			min = 0
		}

		targetData := map[string]interface{}{
			"tag":    pt.Tag,
			"ip":     pt.IP,
			"points": points,
			"stats": map[string]interface{}{
				"avg":   avg,
				"min":   min,
				"max":   max,
				"count": count,
			},
		}
		result["targets"] = append(result["targets"].([]map[string]interface{}), targetData)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleConfig 配置管理
func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		// 返回当前配置
		cfg := map[string]interface{}{
			"monthly_limit_gb": s.cfg.MonthlyLimitGB,
			"billing_mode":     s.cfg.BillingMode,
			"reset_day":        s.cfg.ResetDay,
			"alert_thresholds": s.cfg.AlertThresholds,
			"ping_targets":     s.cfg.PingTargets,
			"telegram_enabled": s.cfg.TelegramBotToken != "",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cfg)
		return
	}

	// POST 更新配置 (TODO: 持久化到数据库)
	http.Error(w, "Not implemented", http.StatusNotImplemented)
}

// handleStatic 静态文件服务
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	// TODO: 嵌入静态文件
	http.ServeFile(w, r, "web"+r.URL.Path)
}
