#!/usr/bin/env bash
# Stop VRS Lab, pull the latest code, and keep a newer server-built snapshot.
# Called by deploy/setup.sh and deploy/update.sh.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vrs}"
APP_USER="${APP_USER:-vrs}"
REPO_URL="${REPO_URL:-https://gitee.com/little-tiger-tooth12/vrs-lab.git}"
BRANCH="${BRANCH:-master}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行。" >&2
  exit 1
fi
if [ ! -d "$APP_DIR/.git" ]; then
  echo "${APP_DIR} 不是 Git 仓库。" >&2
  exit 1
fi

git config --global --add safe.directory "$APP_DIR" || true

WAS_ACTIVE=0
if systemctl is-active --quiet vrs 2>/dev/null; then
  WAS_ACTIVE=1
  systemctl stop vrs || true
fi

BACKUP="$(mktemp -d)"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$WAS_ACTIVE" -eq 1 ]; then
    systemctl start vrs || true
  fi
  rm -rf "$BACKUP"
}
trap cleanup EXIT

HAVE_BACKUP=0
if [ -f "$APP_DIR/data.js" ] && [ -f "$APP_DIR/data/meta.json" ]; then
  cp -f "$APP_DIR/data.js" "$BACKUP/data.js"
  cp -f "$APP_DIR/data/meta.json" "$BACKUP/meta.json"
  HAVE_BACKUP=1
fi

cd "$APP_DIR"
git remote set-url origin "$REPO_URL"
echo "==> 拉取 origin/${BRANCH}"
git fetch --depth 1 origin "$BRANCH"
git reset --hard "origin/$BRANCH"

if [ "$HAVE_BACKUP" -eq 1 ]; then
  local_latest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("latestDate", ""))' "$BACKUP/meta.json")"
  repo_latest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("latestDate", ""))' "$APP_DIR/data/meta.json")"
  if [ -n "$local_latest" ] && [ "$local_latest" \> "$repo_latest" ]; then
    echo "==> 保留服务器上更新的快照数据：${local_latest}"
    cp -f "$BACKUP/data.js" "$APP_DIR/data.js"
    cp -f "$BACKUP/meta.json" "$APP_DIR/data/meta.json"
  fi
fi

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# A private-repo remote URL can contain a token; keep it out of other users' reach.
if [ -f "$APP_DIR/.git/config" ]; then
  chmod 600 "$APP_DIR/.git/config" || true
fi
