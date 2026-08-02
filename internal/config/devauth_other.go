//go:build !darwin

package config

// 生产构建（Linux）不提供免登录开关，说明见 devauth_darwin.go。
const devAuthAllowed = false
