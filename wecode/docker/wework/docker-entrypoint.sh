#!/bin/sh
set -e

if [ -z "${BACKEND_URL}" ]; then
  echo "ERROR: BACKEND_URL is not set"
  exit 1
fi

js_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

sed_escape() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

APP_BASE_PATH="${APP_BASE_PATH:-${VITE_APP_BASE_PATH:-/wework/}}"
API_BASE_URL="${PUBLIC_API_BASE_URL:-${API_BASE_URL:-${VITE_API_BASE_URL:-}}}"
SOCKET_BASE_URL="${SOCKET_BASE_URL:-${VITE_SOCKET_BASE_URL:-}}"
SOCKET_PATH="${SOCKET_PATH:-${VITE_SOCKET_PATH:-}}"
LOGIN_MODE="${LOGIN_MODE:-${VITE_LOGIN_MODE:-}}"
OIDC_LOGIN_TEXT="${OIDC_LOGIN_TEXT:-${VITE_OIDC_LOGIN_TEXT:-}}"
CLOUD_DEVICE_SCALING_WIKI_URL="${CLOUD_DEVICE_SCALING_WIKI_URL:-${VITE_CLOUD_DEVICE_SCALING_WIKI_URL:-}}"
RUNTIME_CONFIG_FILE="/usr/share/nginx/html/runtime-config.js"

cat > "${RUNTIME_CONFIG_FILE}" <<EOF
window.__WEWORK_RUNTIME_CONFIG__ = {
  appBasePath: "$(js_escape "${APP_BASE_PATH}")" || undefined,
  apiBaseUrl: "$(js_escape "${API_BASE_URL}")" || undefined,
  socketBaseUrl: "$(js_escape "${SOCKET_BASE_URL}")" || window.location.origin,
  socketPath: "$(js_escape "${SOCKET_PATH}")" || undefined,
  loginMode: "$(js_escape "${LOGIN_MODE}")" || undefined,
  oidcLoginText: "$(js_escape "${OIDC_LOGIN_TEXT}")" || undefined,
  cloudDeviceScalingWikiUrl: "$(js_escape "${CLOUD_DEVICE_SCALING_WIKI_URL}")" || undefined
}
EOF

sed -i "s|__BACKEND_URL__|$(sed_escape "${BACKEND_URL}")|g" /etc/nginx/conf.d/default.conf
exec nginx -g "daemon off;"
