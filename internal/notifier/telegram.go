// Package notifier 通知发送
package notifier

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/hh/heliox-mon/internal/config"
	"github.com/hh/heliox-mon/internal/storage"
)

// Notifier 通知发送器
type Notifier struct {
	cfg *config.Config
	db  *storage.DB
}

// New 创建通知器
func New(cfg *config.Config, db *storage.DB) *Notifier {
	return &Notifier{cfg: cfg, db: db}
}

// SendTrafficAlert 发送流量报警
func (n *Notifier) SendTrafficAlert(usedGB, limitGB int, percent float64, resetDate string, daysLeft int, threshold int) error {
	if n.cfg.TelegramBotToken == "" || n.cfg.TelegramChatID == "" {
		return nil
	}

	// 检查冷却期（同级别 24 小时内不重复发送）
	cutoff := time.Now().Add(-24 * time.Hour).Unix()
	var count int
	n.db.QueryRow("SELECT COUNT(*) FROM alert_records WHERE threshold = ? AND ts > ?", threshold, cutoff).Scan(&count)
	if count > 0 {
		return nil // 冷却期内
	}

	// 构造消息
	msg := fmt.Sprintf(`⚠️ 流量预警 [%s]

📊 当前: %d GB / %d GB (%.1f%%)
📉 剩余: %d GB
📅 重置: %s (%d 天后)

⏰ 检测时间: %s`,
		n.cfg.ServerName,
		usedGB, limitGB, percent,
		limitGB-usedGB,
		resetDate, daysLeft,
		time.Now().In(n.cfg.Timezone).Format("2006-01-02 15:04 MST"),
	)

	if err := n.sendTelegram(msg); err != nil {
		return err
	}

	// 记录报警
	n.db.Exec("INSERT INTO alert_records (ts, threshold, message) VALUES (?, ?, ?)",
		time.Now().Unix(), threshold, msg)

	return nil
}

// sendTelegram 发送 Telegram 消息
func (n *Notifier) sendTelegram(text string) error {
	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", n.cfg.TelegramBotToken)

	payload := map[string]string{
		"chat_id": n.cfg.TelegramChatID,
		"text":    text,
	}
	body, _ := json.Marshal(payload)

	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Telegram API 返回 %d", resp.StatusCode)
	}

	return nil
}
