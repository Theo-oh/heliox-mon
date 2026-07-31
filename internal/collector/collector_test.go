package collector

import "testing"

func TestPushStealWindowNotFull(t *testing.T) {
	c := &Collector{}

	if got := c.pushSteal(3); got != 3 {
		t.Errorf("首个样本的均值 = %v, 期望 3", got)
	}
	if got := c.pushSteal(1); got != 2 {
		t.Errorf("两个样本的均值 = %v, 期望 2", got)
	}
}

// TestPushStealWindowRolls 窗口满后应只保留最近 stealWindowSize 个样本，
// 早期的高 steal 不该一直把均值吊高
func TestPushStealWindowRolls(t *testing.T) {
	c := &Collector{}

	for i := 0; i < stealWindowSize; i++ {
		c.pushSteal(10)
	}
	if got := c.pushSteal(10); got != 10 {
		t.Errorf("全 10 的窗口均值 = %v, 期望 10", got)
	}

	for i := 0; i < stealWindowSize; i++ {
		c.pushSteal(0)
	}
	if got := c.pushSteal(0); got != 0 {
		t.Errorf("样本全部换成 0 后均值 = %v, 期望 0", got)
	}
}
