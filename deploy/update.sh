#!/usr/bin/env bash
# Pull the latest code and restart VRS Lab.
#
# Usage:
#   sudo bash /opt/vrs/deploy/update.sh
set -euo pipefail

APP_DIR="/opt/vrs"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash $APP_DIR/deploy/update.sh" >&2
  exit 1
fi

bash "$APP_DIR/deploy/sync.sh"

if ! cmp -s "$APP_DIR/deploy/vrs.service" /etc/systemd/system/vrs.service; then
  echo "==> 更新 systemd 服务定义"
  install -m 0644 "$APP_DIR/deploy/vrs.service" /etc/systemd/system/vrs.service
  systemctl daemon-reload
fi

echo "==> 启动服务"
systemctl start vrs
systemctl --no-pager --lines=5 status vrs || true

echo
echo "完成。查看日志：journalctl -u vrs -n 100 --no-pager"
