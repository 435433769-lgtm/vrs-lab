#!/usr/bin/env bash
# VRS Lab basic security / health check.
#
# Usage:
#   sudo bash /opt/vrs/deploy/security-check.sh
#   BASE=https://vrs.example.com sudo bash /opt/vrs/deploy/security-check.sh
#
# It does not change configuration or install packages. It does trigger one
# normal update check (POST /api/check) to verify rate limiting. Exit code is
# the number of failed checks (0 means everything important passed).
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/vrs}"
BASE="${BASE:-http://127.0.0.1}"
BASE="${BASE%/}"

FAIL=0
WARN=0

ok()   { printf '[OK]   %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; WARN=$((WARN + 1)); }
fail() { printf '[FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }

code() {
  local result
  result="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true)"
  printf '%s' "${result:-000}"
}

headers() {
  curl -s -D - -o /dev/null --max-time 15 "$@" 2>/dev/null || true
}

if ! command -v curl >/dev/null 2>&1; then
  echo "需要 curl，请先安装：sudo apt-get install -y curl" >&2
  exit 1
fi

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1 && python -c 'pass' >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

echo "VRS Lab 安全检查"
echo "应用目录：${APP_DIR}"
echo "检查地址：${BASE}"
echo

echo "== 服务 =="
if systemctl is-active --quiet vrs 2>/dev/null; then
  ok "vrs.service 正在运行"
else
  fail "vrs.service 没有运行"
fi

if systemctl is-active --quiet nginx 2>/dev/null; then
  ok "nginx.service 正在运行"
else
  fail "nginx.service 没有运行"
fi

svc_user="$(systemctl show -p User --value vrs 2>/dev/null || true)"
if [ "$svc_user" = "vrs" ]; then
  ok "vrs.service 使用非 root 用户：vrs"
elif [ -n "$svc_user" ] && [ "$svc_user" != "root" ]; then
  ok "vrs.service 使用非 root 用户：${svc_user}"
else
  fail "vrs.service 没有使用专用非 root 用户"
fi

echo
echo "== 端口 =="
if command -v ss >/dev/null 2>&1; then
  if ss -tln 2>/dev/null | grep -q ':80 '; then
    ok "80 端口已监听"
  else
    fail "80 端口没有监听"
  fi

  listener="$(ss -tln 2>/dev/null | awk '$4 ~ /:5173$/ {print $4; exit}')"
  if [ -z "$listener" ]; then
    fail "5173 没有监听（vrs.service 可能异常）"
  elif printf '%s' "$listener" | grep -q '^127\.0\.0\.1:5173$'; then
    ok "5173 仅监听 127.0.0.1"
  else
    fail "5173 暴露在非本机地址：${listener}"
  fi

  if ss -tln 2>/dev/null | grep -q ':443 '; then
    ok "443 端口已监听（HTTPS）"
  else
    warn "443 未监听（没有域名/HTTPS 时正常）"
  fi
else
  warn "没有 ss 命令，跳过端口检查"
fi

echo
echo "== 公开页面 =="
for path in "/" "/data.js" "/data/meta.json" "/api/meta"; do
  status="$(code "${BASE}${path}")"
  if [ "$status" = "200" ]; then
    ok "${path} -> 200"
  else
    fail "${path} -> ${status}"
  fi
done

meta_body="$(curl -s --max-time 10 "${BASE}/api/meta" 2>/dev/null || true)"
if printf '%s' "$meta_body" | grep -q '"latestDate"'; then
  ok "/api/meta 返回了 latestDate"
else
  fail "/api/meta 没有返回预期 JSON"
fi

echo
echo "== 敏感路径（应为 404）=="
for path in \
  "/.git/config" \
  "/scripts/dev_server.py" \
  "/scripts/build_data.py" \
  "/data/raw" \
  "/deploy/setup.sh" \
  "/README.md"; do
  status="$(code "${BASE}${path}")"
  if [ "$status" = "404" ]; then
    ok "${path} -> 404"
  else
    fail "${path} -> ${status}（不应公开）"
  fi
done

echo
echo "== API 限流 =="
c1="$(code -X POST "${BASE}/api/check")"
c2="$(code -X POST "${BASE}/api/check")"
if [ "$c1" = "429" ] || [ "$c2" = "429" ]; then
  ok "手动检查限流生效（${c1} / ${c2}）"
else
  fail "手动检查限流未生效（${c1} / ${c2}）"
fi

get_check="$(code "${BASE}/api/check")"
if [ "$get_check" = "404" ]; then
  ok "GET /api/check -> 404"
else
  warn "GET /api/check -> ${get_check}（预期 404）"
fi

echo
echo "== 响应头 =="
root_headers="$(headers "${BASE}/")"
for expected in \
  "X-Content-Type-Options: nosniff" \
  "Referrer-Policy: same-origin" \
  "Cache-Control: no-cache"; do
  if printf '%s' "$root_headers" | grep -qi "$expected"; then
    ok "首页包含 ${expected}"
  else
    warn "首页缺少 ${expected}"
  fi
done

api_headers="$(headers "${BASE}/api/meta")"
if printf '%s' "$api_headers" | grep -qi 'Cache-Control: no-store'; then
  ok "/api/meta 使用 no-store"
else
  fail "/api/meta 没有 no-store"
fi

data_headers="$(headers "${BASE}/data.js?v=security-check")"
if printf '%s' "$data_headers" | grep -qi 'Cache-Control: public, max-age=31536000, immutable'; then
  ok "data.js 版本化 URL 长缓存"
else
  warn "data.js 没有返回预期的长缓存头"
fi

gzip_headers="$(curl -s -D - -o /dev/null --max-time 20 \
  -H 'Accept-Encoding: gzip' "${BASE}/data.js" 2>/dev/null || true)"
if printf '%s' "$gzip_headers" | grep -qi 'Content-Encoding: gzip'; then
  ok "data.js 启用了 gzip"
else
  warn "data.js 没有返回 gzip（Nginx 配置可能未生效）"
fi

echo
echo "== 数据包一致性 =="
if [ -z "$PYTHON_BIN" ]; then
  warn "没有可用的 python3/python，跳过数据包检查"
elif [ -f "${APP_DIR}/data.js" ] && [ -f "${APP_DIR}/data/meta.json" ]; then
  detail="$("$PYTHON_BIN" - "${APP_DIR}" <<'PY' 2>/dev/null
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
meta = json.loads((root / "data/meta.json").read_text(encoding="utf-8-sig"))
size = (root / "data.js").stat().st_size
expected = meta.get("dataBytes")
print(f"latest={meta.get('latestDate')} builtAt={meta.get('builtAt')} size={size / 1024 / 1024:.2f}MB")
if expected and expected != size:
    print(f"WARN dataBytes={expected} actual={size}")
    sys.exit(2)
PY
)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "data.js 与 data/meta.json 大小一致"
  else
    warn "data.js 与 data/meta.json 大小不一致"
  fi
  [ -n "$detail" ] && echo "       ${detail}"
else
  fail "没有找到 ${APP_DIR}/data.js 或 ${APP_DIR}/data/meta.json"
fi

echo
echo "== Git 凭据 =="
if [ -d "${APP_DIR}/.git" ]; then
  remote_url="$(git -C "${APP_DIR}" remote get-url origin 2>/dev/null || true)"
  case "$remote_url" in
    https://*@*)
      warn "Git remote URL 含明文凭据，请确认 /opt/vrs/.git/config 权限为 600"
      ;;
    *)
      ok "Git remote URL 未包含明文凭据"
      ;;
  esac

  mode="$(stat -c '%a' "${APP_DIR}/.git/config" 2>/dev/null || true)"
  if [ "$mode" = "600" ]; then
    ok ".git/config 权限为 600"
  else
    warn ".git/config 权限为 ${mode:-未知}，建议 chmod 600"
  fi
else
  warn "没有找到 ${APP_DIR}/.git，跳过 Git 检查"
fi

echo
echo "== 磁盘 =="
root_use="$(df -P / | awk 'NR==2 {print $5}')"
root_pct="${root_use%\%}"
if [ -n "$root_pct" ] && [ "$root_pct" -ge 85 ] 2>/dev/null; then
  warn "根分区使用率 ${root_use}，建议清理或扩容"
else
  ok "根分区使用率 ${root_use}"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "结论：基础安全检查通过。"
else
  echo "结论：有 ${FAIL} 项失败，请按上面的 [FAIL] 处理。"
fi
[ "$WARN" -gt 0 ] && echo "另有 ${WARN} 项提醒，不一定是问题。"
echo
echo "提醒：腾讯云防火墙只放行 22/80/443；没有域名时是 HTTP，不要输入敏感信息。"
echo "      已经启用 HTTPS 的话，用：BASE=https://你的域名 sudo bash $0"

exit "$FAIL"
