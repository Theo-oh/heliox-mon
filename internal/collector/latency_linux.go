package collector

import (
	"context"
	"errors"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// doCollectLatency 执行延迟采集
func (c *Collector) doCollectLatency() {
	now := time.Now().Unix()

	for _, target := range c.cfg.PingTargets {
		res, ok := c.pingStats(target.IP)
		if !ok {
			// 环境/执行错误（ping 不可用、命令超时等）跳过本次记录，
			// 留数据空洞而非伪造成“目标丢包”，避免污染丢包率统计
			continue
		}

		if dbErr := c.insertLatency(now, target.IP, res); dbErr != nil {
			log.Printf("保存延迟记录失败: %v", dbErr)
		}
	}
}

// pingStats 使用系统 ping 命令进行延迟测试。
// 返回解析结果与是否成功；ok=false 表示本次因环境/执行错误失败，调用方应跳过记录。
func (c *Collector) pingStats(target string) (latencySummary, bool) {
	count := c.cfg.PingCount
	if count <= 0 {
		count = 20
	}
	timeout := c.cfg.PingTimeout
	if timeout <= 0 {
		timeout = time.Second
	}
	interval := c.cfg.PingGap
	if interval <= 0 {
		interval = 200 * time.Millisecond
	}

	// -W / -i 直接用秒（含小数），不再 int() 截断把毫秒级配置静默归零
	timeoutArg := strconv.FormatFloat(timeout.Seconds(), 'f', -1, 64)
	intervalArg := strconv.FormatFloat(interval.Seconds(), 'f', -1, 64)

	// 每包最坏 ≈ 发包间隔 + 单包超时，再加缓冲，用 context 兜底
	budget := time.Duration(count)*(interval+timeout) + 5*time.Second
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()

	// 去掉 -q：要逐包 time= 才能算真 P95/max。间隔走 PING_GAP_MS（此前配置了却没传给 ping）
	cmd := exec.CommandContext(ctx, "ping",
		"-c", strconv.Itoa(count),
		"-i", intervalArg,
		"-W", timeoutArg,
		target,
	)
	output, err := cmd.CombinedOutput()

	if ctx.Err() == context.DeadlineExceeded {
		log.Printf("警告：ping %s 超时被强制终止，跳过本次记录", target)
		return latencySummary{}, false
	}

	// 无论退出码如何都先尝试解析：100% 丢包时 ping 退出码为 1，
	// 但仍会打印完整统计行，必须据此解析而非一律当作错误
	if res, parsed := parsePingOutput(string(output)); parsed {
		return res, true
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return latencySummary{Sent: count, Lost: count}, true
	}

	log.Printf("警告：ping %s 执行失败，跳过本次记录: %v，输出: %s",
		target, err, strings.TrimSpace(string(output)))
	return latencySummary{}, false
}
