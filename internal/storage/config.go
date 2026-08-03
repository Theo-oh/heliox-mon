package storage

import (
	"database/sql"
	"errors"
	"fmt"
)

// GetConfigValue 读取 config 表中的配置项；键不存在时返回空串且 err 为 nil，
// 由调用方决定「缺失」意味着什么（生成默认值还是报错）。
func (db *DB) GetConfigValue(key string) (string, error) {
	var value string
	err := db.QueryRow(`SELECT value FROM config WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("读取配置项 %s 失败: %w", key, err)
	}
	return value, nil
}

// SetConfigValue 写入（或覆盖）config 表中的配置项
func (db *DB) SetConfigValue(key, value string) error {
	_, err := db.Exec(
		`INSERT INTO config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	if err != nil {
		return fmt.Errorf("写入配置项 %s 失败: %w", key, err)
	}
	return nil
}
