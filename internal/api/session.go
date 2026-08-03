package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hh/heliox-mon/internal/storage"
)

const (
	authCookieName = "heliox_auth"
	authSessionTTL = 30 * 24 * time.Hour // 30 天
	// sessionRenewBefore 剩余有效期低于此值时顺带续签，活跃用户不会被 30 天硬到期踢下线
	sessionRenewBefore = authSessionTTL / 2

	sessionSecretKey  = "session_secret" // config 表里的键名
	sessionSecretSize = 32
	// sessionTokenPrefix 参与签名，将来换签名格式时旧 token 会自然失效
	sessionTokenPrefix = "v1"
)

// loadSessionSecret 取出会话签名密钥，没有则生成一把随机的存进库。
//
// 密钥持久化是这里的关键：早期实现把 session 放在进程内存的 map 里，服务一重启
// （更新二进制、systemd restart）全部会话就凭空消失，浏览器还揣着有效期内的 Cookie
// 却被打回登录页。密钥落库后 token 变成无状态可验证的，重启不再影响已登录的浏览器。
//
// 之所以不从 HELIOX_MON_PASS 派生：那样攻击者拿到任意一个自己的合法 token 就能离线
// 爆破管理员密码，把会话安全和密码强度绑死。
func loadSessionSecret(db *storage.DB) ([]byte, error) {
	stored, err := db.GetConfigValue(sessionSecretKey)
	if err != nil {
		return nil, err
	}
	if stored != "" {
		secret, err := hex.DecodeString(stored)
		if err == nil && len(secret) == sessionSecretSize {
			return secret, nil
		}
		// 库里的值坏了（截断/手工改过）：重新生成，代价仅是已登录用户重登一次
		log.Printf("会话密钥无效，重新生成（已登录用户需重新登录）")
	}

	secret := make([]byte, sessionSecretSize)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("生成会话密钥失败: %w", err)
	}
	if err := db.SetConfigValue(sessionSecretKey, hex.EncodeToString(secret)); err != nil {
		return nil, err
	}
	return secret, nil
}

// issueToken 签发形如 "<过期时间戳>.<HMAC>" 的无状态会话 token
func (s *Server) issueToken(now time.Time) string {
	exp := strconv.FormatInt(now.Add(authSessionTTL).Unix(), 10)
	return exp + "." + hex.EncodeToString(s.signSession(exp))
}

// validateToken 校验 token 并返回其过期时间戳（Unix 秒），无效时 ok 为 false
func (s *Server) validateToken(token string) (exp int64, ok bool) {
	rawExp, mac, found := strings.Cut(token, ".")
	if !found {
		return 0, false
	}
	got, err := hex.DecodeString(mac)
	if err != nil {
		return 0, false
	}
	// 先比签名再看过期：先解析未经验证的时间戳没有意义
	if subtle.ConstantTimeCompare(got, s.signSession(rawExp)) != 1 {
		return 0, false
	}
	exp, err = strconv.ParseInt(rawExp, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return 0, false
	}
	return exp, true
}

func (s *Server) signSession(exp string) []byte {
	mac := hmac.New(sha256.New, s.sessionSecret)
	mac.Write([]byte(sessionTokenPrefix + "|" + exp))
	return mac.Sum(nil)
}

// setSessionCookie 写出会话 Cookie。Secure 跟随请求实际协议，
// 反代场景（Cloudflare Tunnel）看 X-Forwarded-Proto。
func setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS(r),
		MaxAge:   int(authSessionTTL.Seconds()),
		SameSite: http.SameSiteLaxMode,
	})
}
