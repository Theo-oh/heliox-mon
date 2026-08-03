package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hh/heliox-mon/internal/config"
	"github.com/hh/heliox-mon/internal/storage"
)

func newSessionServer(t *testing.T) (*Server, *storage.DB) {
	t.Helper()
	db, err := storage.NewDB(t.TempDir())
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	secret, err := loadSessionSecret(db)
	if err != nil {
		t.Fatalf("loadSessionSecret 失败: %v", err)
	}
	return &Server{db: db, sessionSecret: secret}, db
}

func TestSessionSecretPersists(t *testing.T) {
	dir := t.TempDir()
	db1, err := storage.NewDB(dir)
	if err != nil {
		t.Fatalf("NewDB 失败: %v", err)
	}
	secret1, err := loadSessionSecret(db1)
	if err != nil {
		t.Fatalf("loadSessionSecret 失败: %v", err)
	}
	token := (&Server{sessionSecret: secret1}).issueToken(time.Now())
	db1.Close()

	// 模拟进程重启：同一数据目录重新打开
	db2, err := storage.NewDB(dir)
	if err != nil {
		t.Fatalf("重开 NewDB 失败: %v", err)
	}
	defer db2.Close()
	secret2, err := loadSessionSecret(db2)
	if err != nil {
		t.Fatalf("重开 loadSessionSecret 失败: %v", err)
	}

	if _, ok := (&Server{sessionSecret: secret2}).validateToken(token); !ok {
		t.Error("重启后旧 token 应仍然有效")
	}
}

func TestValidateToken(t *testing.T) {
	s, _ := newSessionServer(t)
	other, _ := newSessionServer(t) // 另一把密钥

	valid := s.issueToken(time.Now())
	if _, ok := s.validateToken(valid); !ok {
		t.Error("刚签发的 token 应有效")
	}

	expired := s.issueToken(time.Now().Add(-authSessionTTL - time.Minute))
	if _, ok := s.validateToken(expired); ok {
		t.Error("过期 token 应无效")
	}

	if _, ok := other.validateToken(valid); ok {
		t.Error("换密钥后 token 应无效")
	}

	// 改过期时间但签名照抄：必须被签名校验拦下，否则可无限续期
	rawExp, mac, _ := strings.Cut(valid, ".")
	exp, err := strconv.ParseInt(rawExp, 10, 64)
	if err != nil {
		t.Fatalf("解析过期时间失败: %v", err)
	}
	forged := strconv.FormatInt(exp+86400, 10) + "." + mac
	if _, ok := s.validateToken(forged); ok {
		t.Error("篡改过期时间的 token 应无效")
	}

	for _, bad := range []string{"", "noseparator", ".", "abc.def", valid + "x"} {
		if _, ok := s.validateToken(bad); ok {
			t.Errorf("畸形 token %q 应无效", bad)
		}
	}
}

// TestAuthRenewsCookie 覆盖滑动续期：临近过期才重签，剩余期充裕时不该动 Cookie
func TestAuthRenewsCookie(t *testing.T) {
	s, _ := newSessionServer(t)
	s.cfg = &config.Config{Username: "admin", Password: "x"}

	cases := []struct {
		name      string
		issuedAt  time.Time
		wantRenew bool
	}{
		{"刚签发", time.Now(), false},
		{"临近过期", time.Now().Add(-authSessionTTL + sessionRenewBefore - time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
			req.AddCookie(&http.Cookie{Name: authCookieName, Value: s.issueToken(tc.issuedAt)})
			rec := httptest.NewRecorder()

			called := false
			s.auth(func(http.ResponseWriter, *http.Request) { called = true })(rec, req)

			if !called {
				t.Fatalf("状态码 %d：有效 Cookie 应放行", rec.Code)
			}
			if got := rec.Header().Get("Set-Cookie") != ""; got != tc.wantRenew {
				t.Errorf("续签 = %v, want %v", got, tc.wantRenew)
			}
		})
	}
}

func TestIssuedTokenExpiry(t *testing.T) {
	s, _ := newSessionServer(t)
	now := time.Now()
	exp, ok := s.validateToken(s.issueToken(now))
	if !ok {
		t.Fatal("token 应有效")
	}
	if want := now.Add(authSessionTTL).Unix(); exp != want {
		t.Errorf("过期时间 = %d, want %d", exp, want)
	}
}
