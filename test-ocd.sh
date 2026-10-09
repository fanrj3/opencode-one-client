#!/bin/zsh
# ocd 功能自测（--config 全部指向临时配置，不碰真实配置）
set -u
TD="${TMPDIR:-/tmp}"; TD="${TD%/}/ocdtest"
rm -rf "$TD"; mkdir -p "$TD"
BIN="$(cd -- "$(dirname -- "$0")" && pwd)/bin/ocd.js"
CFG="$TD/config.json"
MACPW=$(jq -r '.password' "$HOME/.config/opencode/service.json")
oc() { node "$BIN" "$@"; }

echo "=== 1) add：URL 归一化（127.0.0.1:49374 无 scheme 无端口）+ 默认字段 ==="
oc --config "$CFG" add demo --url 127.0.0.1:49374 --password "$MACPW"
echo "--- 落盘内容:"
jq -c '.devices[0]' "$CFG"

echo
echo "=== 2) add 错误密码 → 应报 401、不落盘 ==="
oc --config "$CFG" add demo --url http://127.0.0.1:49374 --password wrongpass || echo "[expected-fail]"
echo "--- devices 数量: $(jq '.devices|length' "$CFG")　密码前缀: $(jq -r '.devices[0].password' "$CFG" | cut -c1-6)…"

echo
echo "=== 3) 更新既有设备（只给 --name，url/密码沿用已有）==="
oc --config "$CFG" add demo --name "演示机"
jq -c '.devices[0] | {id,name,url,password: (.password|cut)}' "$CFG" 2>/dev/null || jq -c '.devices[0] | {id,name,url}' "$CFG"

echo
echo "=== 4) list（临时配置）==="
oc --config "$CFG" list

echo
echo "=== 5) add --local ==="
oc --config "$CFG" add --local --id 本机测试
jq -c '.devices[] | select(.id=="本机测试") | {id,url,platform,defaultDir}' "$CFG"

echo
echo "=== 6) remove ==="
oc --config "$CFG" remove demo
oc --config "$CFG" remove 本机测试
echo "--- devices: $(jq '.devices|length' "$CFG")"
oc --config "$CFG" remove 不存在 || echo "[expected-fail]"

echo
echo "=== 7) invite（--id/--url 覆盖；预期：服务正常 + 回环警告 + 生成行）==="
oc invite --id demo --url http://127.0.0.1:49374

echo
echo "=== 8) invite（无参数：自动 Tailscale 名）— 只看生成行 ==="
oc invite | tail -6

echo
echo "=== done ==="
