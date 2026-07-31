package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// tcpStateEstablished /proc/net/tcp 的连接状态列，01 即 TCP_ESTABLISHED
const tcpStateEstablished = "01"

// countEstablished 统计各代理端口上的 ESTABLISHED 连接数。
// 相比 CPU/内存这类通用指标，「此刻有多少人在用」才是代理服务最直接的健康信号，
// 连接数异常暴涨也能一眼看出。
func countEstablished(ports []int) map[int]int {
	if len(ports) == 0 {
		return nil
	}

	want := make(map[uint64]int, len(ports))
	for _, p := range ports {
		if p > 0 {
			want[uint64(p)] = p
		}
	}
	if len(want) == 0 {
		return nil
	}

	counts := make(map[int]int, len(want))
	for _, p := range want {
		counts[p] = 0
	}

	// IPv4 与 IPv6 是两张独立的表，监听 :: 的服务连接会记在 tcp6 里
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		countEstablishedIn(path, want, counts)
	}
	return counts
}

// countEstablishedIn 累加单张 /proc/net/tcp* 表中命中端口的 ESTABLISHED 连接
func countEstablishedIn(path string, want map[uint64]int, counts map[int]int) {
	file, err := os.Open(path)
	if err != nil {
		// IPv6 未启用时 /proc/net/tcp6 不存在，属正常情况
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Scan() // 跳过表头

	for scanner.Scan() {
		// sl local_address rem_address st ...
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 || fields[3] != tcpStateEstablished {
			continue
		}

		port, ok := parseHexPort(fields[1])
		if !ok {
			continue
		}
		if p, hit := want[port]; hit {
			counts[p]++
		}
	}
}

// parseHexPort 从 /proc/net/tcp 的 "地址:端口" 十六进制字段中取出端口
func parseHexPort(addr string) (uint64, bool) {
	idx := strings.LastIndex(addr, ":")
	if idx < 0 {
		return 0, false
	}
	port, err := strconv.ParseUint(addr[idx+1:], 16, 32)
	if err != nil {
		return 0, false
	}
	return port, true
}

// readTCPStats 读取 /proc/net/snmp 中的 TCP 累计计数
func readTCPStats() (tcpStats, bool) {
	file, err := os.Open("/proc/net/snmp")
	if err != nil {
		return tcpStats{}, false
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "Tcp:") {
			continue
		}
		// TCP 段由两行组成：先是字段名行，紧接着是对应的数值行
		if !scanner.Scan() {
			return tcpStats{}, false
		}
		return parseTCPSnmp(line, scanner.Text())
	}
	return tcpStats{}, false
}

// parseTCPSnmp 按表头名定位 OutSegs/RetransSegs 的列。
// 不写死列号是因为该表的字段随内核版本增删过，按名取值才不会串列。
func parseTCPSnmp(header, values string) (tcpStats, bool) {
	names := strings.Fields(header)
	vals := strings.Fields(values)
	if len(names) != len(vals) {
		return tcpStats{}, false
	}

	var t tcpStats
	var gotOut, gotRetrans bool
	for i, name := range names {
		switch name {
		case "OutSegs":
			v, err := strconv.ParseUint(vals[i], 10, 64)
			if err != nil {
				return tcpStats{}, false
			}
			t.outSegs, gotOut = v, true
		case "RetransSegs":
			v, err := strconv.ParseUint(vals[i], 10, 64)
			if err != nil {
				return tcpStats{}, false
			}
			t.retransSegs, gotRetrans = v, true
		}
	}

	return t, gotOut && gotRetrans
}

// getRetransPercent 计算两次采样之间的 TCP 重传率。
// 用差值而非开机以来的累计值：累计值被长期平均稀释后，几乎不会随线路劣化而变动，
// 失去预警意义。
func (c *Collector) getRetransPercent() (float64, bool) {
	cur, ok := readTCPStats()
	if !ok {
		return 0, false
	}

	prev := c.lastTCP
	hadBaseline := c.hasTCPBaseline
	c.lastTCP, c.hasTCPBaseline = cur, true
	if !hadBaseline {
		return 0, false
	}

	// 计数器回退说明发生了重置，以当前值为新基准
	if cur.outSegs <= prev.outSegs || cur.retransSegs < prev.retransSegs {
		return 0, false
	}

	deltaOut := float64(cur.outSegs - prev.outSegs)
	deltaRetrans := float64(cur.retransSegs - prev.retransSegs)
	return clampPercent(100 * deltaRetrans / deltaOut), true
}
