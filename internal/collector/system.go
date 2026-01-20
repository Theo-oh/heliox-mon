package collector

import (
	"bufio"
	"log"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// doCollectSystemMetrics 执行系统资源采集
func (c *Collector) doCollectSystemMetrics() {
	now := time.Now().Unix()

	cpu := c.getCPUPercent()
	memUsed, memTotal := c.getMemoryInfo()
	diskUsed, diskTotal := c.getDiskInfo()
	load1, load5, load15 := c.getLoadAvg()

	_, err := c.db.Exec(
		`INSERT INTO system_metrics (ts, cpu_percent, mem_used, mem_total, disk_used, disk_total, load_1, load_5, load_15)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		now, cpu, memUsed, memTotal, diskUsed, diskTotal, load1, load5, load15,
	)
	if err != nil {
		log.Printf("保存系统指标失败: %v", err)
	}

	// 清理旧数据，只保留最近 1 小时
	_, _ = c.db.Exec("DELETE FROM system_metrics WHERE ts < ?", now-3600)
}

// getCPUPercent 获取 CPU 使用率（通过两次采样差值计算）
func (c *Collector) getCPUPercent() float64 {
	total, idle := c.readCPUStat()
	if total == 0 {
		return 0
	}

	// 首次采样，保存基准值
	if c.lastCPUTotal == 0 {
		c.lastCPUTotal, c.lastCPUIdle = total, idle
		return 0
	}

	// 计算差值
	deltaTotal := total - c.lastCPUTotal
	deltaIdle := idle - c.lastCPUIdle
	c.lastCPUTotal, c.lastCPUIdle = total, idle

	if deltaTotal == 0 {
		return 0
	}

	return 100.0 * float64(deltaTotal-deltaIdle) / float64(deltaTotal)
}

// readCPUStat 读取 /proc/stat 获取 CPU 时间
func (c *Collector) readCPUStat() (total, idle uint64) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return 0, 0
	}

	line := scanner.Text()
	if !strings.HasPrefix(line, "cpu ") {
		return 0, 0
	}

	fields := strings.Fields(line)
	if len(fields) < 5 {
		return 0, 0
	}

	// cpu user nice system idle iowait irq softirq steal guest guest_nice
	for i := 1; i < len(fields); i++ {
		v, _ := strconv.ParseUint(fields[i], 10, 64)
		total += v
		if i == 4 { // idle
			idle = v
		}
	}

	return total, idle
}

// getMemoryInfo 获取内存信息
func (c *Collector) getMemoryInfo() (used, total uint64) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer file.Close()

	var memTotal, memFree, buffers, cached uint64

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		value, _ := strconv.ParseUint(fields[1], 10, 64)
		value *= 1024 // kB to bytes

		switch fields[0] {
		case "MemTotal:":
			memTotal = value
		case "MemFree:":
			memFree = value
		case "Buffers:":
			buffers = value
		case "Cached:":
			cached = value
		}
	}

	// 实际使用 = Total - Free - Buffers - Cached
	used = memTotal - memFree - buffers - cached
	return used, memTotal
}

// getDiskInfo 获取磁盘使用情况（根目录）
func (c *Collector) getDiskInfo() (used, total uint64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err != nil {
		return 0, 0
	}

	total = stat.Blocks * uint64(stat.Bsize)
	free := stat.Bfree * uint64(stat.Bsize)
	used = total - free

	return used, total
}

// getLoadAvg 获取系统负载
func (c *Collector) getLoadAvg() (load1, load5, load15 float64) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0
	}

	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0
	}

	load1, _ = strconv.ParseFloat(fields[0], 64)
	load5, _ = strconv.ParseFloat(fields[1], 64)
	load15, _ = strconv.ParseFloat(fields[2], 64)

	return load1, load5, load15
}
