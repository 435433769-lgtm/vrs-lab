#!/usr/bin/env bash
# One-command installer for VRS Lab on Ubuntu 22.04/24.04.
#
# Usage:
#   sudo bash deploy/setup.sh --domain vrs.example.com --email you@example.com
#   sudo bash deploy/setup.sh --domain example.com --domain www.example.com --email you@example.com
#   sudo bash deploy/setup.sh                 # IP only, no HTTPS
#
# Environment overrides:
#   REPO_URL=https://gitee.com/little-tiger-tooth12/vrs-lab.git
#   BRANCH=master
set -euo pipefail

APP_DIR="/opt/vrs"
APP_USER="vrs"
REPO_URL="${REPO_URL:-https://gitee.com/little-tiger-tooth12/vrs-lab.git}"
BRANCH="${BRANCH:-master}"
DOMAINS=()
EMAIL="${EMAIL:-}"

usage() {
  cat <<'EOF'
用法:
  sudo bash deploy/setup.sh [--domain 域名 ...] [--email 邮箱]

示例:
  # 只用一个域名
  sudo bash deploy/setup.sh --domain www.example.com --email me@example.com

  # 根域名 + www 共用一个证书
  sudo bash deploy/setup.sh --domain example.com --domain www.example.com --email me@example.com

  # 不填域名，只用公网 IP
  sudo bash deploy/setup.sh

不填域名时只启用 HTTP（用公网 IP 访问）；填写域名时会自动申请 Let's Encrypt 证书并跳转 HTTPS。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--domain 需要一个域名。" >&2
        usage
        exit 1
      fi
      DOMAINS+=("$2")
      shift 2
      ;;
    --email)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--email 需要一个邮箱地址。" >&2
        usage
        exit 1
      fi
      EMAIL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ ${#DOMAINS[@]} -eq 0 ]; then
        DOMAINS+=("$1")
        shift
      else
        echo "未知参数: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash deploy/setup.sh ..." >&2
  exit 1
fi

# Accept "https://example.com/" as well as a bare hostname.
for index in "${!DOMAINS[@]}"; do
  value="${DOMAINS[$index]}"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%.}"
  DOMAINS[$index]="$value"
done

PRIMARY_DOMAIN=""
if [ ${#DOMAINS[@]} -gt 0 ]; then
  PRIMARY_DOMAIN="${DOMAINS[0]}"
fi

# If both example.com and www.example.com are supplied, make www canonical and
# 301 the bare domain to it. Passing only one domain leaves that domain as-is.
CANONICAL_DOMAIN=""
if [ ${#DOMAINS[@]} -gt 1 ]; then
  for candidate in "${DOMAINS[@]}"; do
    case "$candidate" in
      www.*)
        bare="${candidate#www.}"
        for other in "${DOMAINS[@]}"; do
          if [ "$other" = "$bare" ]; then
            CANONICAL_DOMAIN="$candidate"
            break 2
          fi
        done
        ;;
    esac
  done
fi

ROOT_REDIRECT=""
if [ -n "$CANONICAL_DOMAIN" ]; then
  bare="${CANONICAL_DOMAIN#www.}"
  ROOT_REDIRECT="if (\$host = ${bare}) { return 301 https://${CANONICAL_DOMAIN}\$request_uri; }"
  PRIMARY_DOMAIN="$CANONICAL_DOMAIN"
fi

trap 'systemctl start vrs 2>/dev/null || true' ERR

export DEBIAN_FRONTEND=noninteractive

echo "==> 安装系统依赖"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git nginx python3 certbot python3-certbot-nginx

# If the image already enabled ufw, open the web ports. Never enable it here:
# the cloud provider firewall is the primary gate.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 22/tcp || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

echo "==> 创建运行用户 ${APP_USER}"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$APP_DIR" \
    --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"

echo "==> 获取代码到 ${APP_DIR}"
git config --global --add safe.directory "$APP_DIR" || true
if [ -d "$APP_DIR/.git" ]; then
  if [ -f "$APP_DIR/deploy/sync.sh" ]; then
    APP_DIR="$APP_DIR" APP_USER="$APP_USER" REPO_URL="$REPO_URL" BRANCH="$BRANCH" \
      bash "$APP_DIR/deploy/sync.sh"
  else
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  fi
else
  if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]; then
    echo "${APP_DIR} 已存在且不是 Git 仓库，请先备份并移走该目录。" >&2
    exit 1
  fi
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> 写入 systemd 服务"
install -m 0644 "$APP_DIR/deploy/vrs.service" /etc/systemd/system/vrs.service
systemctl daemon-reload
systemctl enable vrs

echo "==> 写入 Nginx 站点"
if [ ${#DOMAINS[@]} -gt 0 ]; then
  SERVER_NAME="${DOMAINS[*]}"
else
  SERVER_NAME="_"
fi
sed -e "s/__DOMAIN__/${SERVER_NAME}/g" \
    -e "s|__ROOT_REDIRECT__|${ROOT_REDIRECT}|g" "$APP_DIR/deploy/nginx.conf" \
  > /etc/nginx/sites-available/vrs
ln -sf /etc/nginx/sites-available/vrs /etc/nginx/sites-enabled/vrs
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> 启动 VRS Lab"
systemctl restart vrs

echo "==> 等待服务响应"
ok=0
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 http://127.0.0.1:5173/api/meta >/dev/null 2>&1 \
     && curl -fsS --max-time 5 http://127.0.0.1:5173/data.js -o /dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "服务未在预期时间内响应，请查看日志：" >&2
  journalctl -u vrs -n 50 --no-pager >&2 || true
  exit 1
fi

if [ ${#DOMAINS[@]} -gt 0 ]; then
  echo "==> 申请 HTTPS 证书（域名：${DOMAINS[*]}）"
  echo "    请确认所有域名的 A 记录都已指向本机公网 IP，且 Cloudflare 代理处于关闭（仅 DNS）状态。"
  CERTBOT_EMAIL_ARGS=(--register-unsafely-without-email)
  if [ -n "$EMAIL" ]; then
    CERTBOT_EMAIL_ARGS=(-m "$EMAIL")
  fi
  CERTBOT_DOMAIN_ARGS=()
  for domain in "${DOMAINS[@]}"; do
    CERTBOT_DOMAIN_ARGS+=(-d "$domain")
  done
  if certbot --nginx "${CERTBOT_DOMAIN_ARGS[@]}" --redirect --non-interactive \
      --agree-tos --keep-until-expiring "${CERTBOT_EMAIL_ARGS[@]}"; then
    systemctl reload nginx
    echo "HTTPS 已启用：https://${PRIMARY_DOMAIN}/"
  else
    echo "证书申请失败，网站仍可通过 HTTP 访问。常见原因：" >&2
    echo "  - DNS 尚未生效或 A 记录不是本机 IP" >&2
    echo "  - Cloudflare 代理未关闭" >&2
    echo "  - 服务器防火墙未放行 80/443" >&2
    echo "修复后可手动重试：certbot --nginx ${CERTBOT_DOMAIN_ARGS[*]} --redirect" >&2
  fi
else
  echo "未填写域名，跳过 HTTPS。之后可运行：sudo bash ${APP_DIR}/deploy/setup.sh --domain 你的域名"
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo
echo "==> 完成"
if [ -n "$PRIMARY_DOMAIN" ]; then
  echo "    网站地址：https://${PRIMARY_DOMAIN}/"
else
  echo "    网站地址：http://${PUBLIC_IP:-服务器公网IP}/"
fi
echo "    查看状态：systemctl status vrs --no-pager"
echo "    查看日志：journalctl -u vrs -n 100 --no-pager"
echo "    更新代码：sudo bash ${APP_DIR}/deploy/update.sh"
echo
echo "提醒：请在云厂商控制台的防火墙中放行 TCP 22、80、443。"
