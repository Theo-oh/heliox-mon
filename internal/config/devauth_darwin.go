//go:build darwin

package config

// devAuthAllowed 免登录开关是否存在于当前构建。
//
// darwin 构建本来就只用于本机开发（采集走 collector_darwin.go 的 mock 实现，在真实服务器上
// 也拿不到有效数据），所以把开关限定在这里：生产的 Linux 二进制里这个常量恒为 false，
// HELIOX_MON_DEV_NO_AUTH 设了也没有任何分支会读它，不存在"误设环境变量导致线上裸奔"。
const devAuthAllowed = true
