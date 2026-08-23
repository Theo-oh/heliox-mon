#!/usr/bin/env bash
# 客户端延迟测量并上报 heliox-mon。依赖: bash, curl, awk
#
# 用法:
#   MON_URL=http://vps-ip:9100 CLIENT_NAME=home-mac REPORT_TOKEN=xxx ./latency-client.sh
#
# 可选环境变量:
#   SAMPLES  单轮有效测量次数（默认 10）
#
# 注意: MON_URL 必须为 VPS 直连地址，不要用 Cloudflare Tunnel 域名——
#       经 Tunnel 测得的是「客户端→CF 边缘」RTT，而非到 VPS 的端到端延迟。
set -euo pipefail
: "${MON_URL:?需设置 MON_URL}" "${CLIENT_NAME:?需设置 CLIENT_NAME}" "${REPORT_TOKEN:?需设置 REPORT_TOKEN}"
N="${SAMPLES:-10}"

# 多发一次用于预热（含 TCP/TLS 握手，不代表净 RTT，稍后丢弃第 1 行）
urls=()
for _ in $(seq $((N + 1))); do urls+=("$MON_URL/api/echo"); done

# 单 curl 进程多 URL 自动复用 keep-alive；每行「状态码 耗时秒」
# 超时/连不上时 http_code=000，必须计为丢包，不能把 time_total≈5 当成成功 RTT
times=$(curl -s -o /dev/null --max-time 5 -w '%{http_code} %{time_total}\n' "${urls[@]}" || true)

# 丢弃第 1 行（预热/握手）。成功只认 echo 的 204，其余（000/超时/5xx）计 lost
# 近邻秩 P95 与服务端一致：rank = ceil(0.95*n)
stats=$(printf '%s\n' "$times" | tail -n +2 | awk -v n="$N" '
  $1 == 204 {
    ms = $2 * 1000
    c++
    v[c] = ms
    s += ms
    ss += ms * ms
  }
  END {
    lost = n - c
    if (c == 0) {
      printf "null null null null null %d 0 []"
      exit
    }
    for (i = 1; i <= c; i++) {
      for (j = i + 1; j <= c; j++) {
        if (v[j] < v[i]) { t = v[i]; v[i] = v[j]; v[j] = t }
      }
    }
    min = v[1]; max = v[c]; avg = s / c
    sd = (c > 1) ? sqrt(ss / c - avg * avg) : 0
    rank = int(0.95 * c)
    if (rank < 0.95 * c) rank++
    if (rank < 1) rank = 1
    if (rank > c) rank = c
    p95 = v[rank]
    json = "["
    for (i = 1; i <= c; i++) {
      if (i > 1) json = json ","
      json = json sprintf("%.2f", v[i])
    }
    json = json "]"
    printf "%.2f %.2f %.2f %.2f %.2f %d %d %s", avg, min, max, p95, sd, lost, c, json
  }')
read -r avg min max p95 mdev lost recv rtts <<< "$stats"

null_or() { [ "$1" = "null" ] && printf "null" || printf "%s" "$1"; }

curl -sf -X POST "$MON_URL/api/latency/report" \
  -H "Authorization: Bearer $REPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"client\":\"$CLIENT_NAME\",\"samples\":[{\"rtt_ms\":$(null_or "$avg"),\"min_rtt\":$(null_or "$min"),\"max_rtt\":$(null_or "$max"),\"p95_rtt\":$(null_or "$p95"),\"mdev\":$(null_or "$mdev"),\"sent\":$N,\"lost\":$lost,\"recv\":$recv,\"rtts\":$rtts}]}"
