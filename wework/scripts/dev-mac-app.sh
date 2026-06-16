#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
EXPLICIT_VITE_API_BASE_URL="${VITE_API_BASE_URL+x}"
EXPLICIT_VITE_API_BASE_URL_VALUE="${VITE_API_BASE_URL:-}"
EXPLICIT_VITE_SOCKET_BASE_URL="${VITE_SOCKET_BASE_URL+x}"
EXPLICIT_VITE_SOCKET_BASE_URL_VALUE="${VITE_SOCKET_BASE_URL:-}"
EXPLICIT_VITE_API_PROXY_TARGET="${VITE_API_PROXY_TARGET+x}"
EXPLICIT_VITE_API_PROXY_TARGET_VALUE="${VITE_API_PROXY_TARGET:-}"
EXPLICIT_VITE_SOCKET_PROXY_TARGET="${VITE_SOCKET_PROXY_TARGET+x}"
EXPLICIT_VITE_SOCKET_PROXY_TARGET_VALUE="${VITE_SOCKET_PROXY_TARGET:-}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -n "$EXPLICIT_VITE_API_BASE_URL" ]; then
  export VITE_API_BASE_URL="$EXPLICIT_VITE_API_BASE_URL_VALUE"
fi

if [ -n "$EXPLICIT_VITE_SOCKET_BASE_URL" ]; then
  export VITE_SOCKET_BASE_URL="$EXPLICIT_VITE_SOCKET_BASE_URL_VALUE"
fi

if [ -n "$EXPLICIT_VITE_API_PROXY_TARGET" ]; then
  export VITE_API_PROXY_TARGET="$EXPLICIT_VITE_API_PROXY_TARGET_VALUE"
fi

if [ -n "$EXPLICIT_VITE_SOCKET_PROXY_TARGET" ]; then
  export VITE_SOCKET_PROXY_TARGET="$EXPLICIT_VITE_SOCKET_PROXY_TARGET_VALUE"
fi

get_local_ip() {
  local ip

  for interface in en0 en1; do
    ip="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      echo "$ip"
      return
    fi
  done

  local default_interface
  default_interface="$(route get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  if [ -n "$default_interface" ]; then
    ip="$(ipconfig getifaddr "$default_interface" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      echo "$ip"
      return
    fi
  fi

  echo "127.0.0.1"
}

is_port_available() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  ! nc -z localhost "$port" >/dev/null 2>&1
}

find_available_port() {
  local port="$1"

  while ! is_port_available "$port"; do
    port=$((port + 1))
  done

  echo "$port"
}

LOCAL_IP="${WEWORK_HOST:-$(get_local_ip)}"
BACKEND_PORT="${BACKEND_PORT:-9100}"
REQUESTED_WEWORK_PORT="${WEWORK_PORT:-1420}"
WEWORK_PORT="$(find_available_port "$REQUESTED_WEWORK_PORT")"

export VITE_API_PROXY_TARGET="${VITE_API_PROXY_TARGET:-http://$LOCAL_IP:$BACKEND_PORT}"
export VITE_SOCKET_PROXY_TARGET="${VITE_SOCKET_PROXY_TARGET:-${WEGENT_SOCKET_URL:-$VITE_API_PROXY_TARGET}}"

TAURI_DEV_CONFIG="$(mktemp -t wework-tauri-dev.XXXXXX.json)"
trap 'rm -f "$TAURI_DEV_CONFIG"' EXIT

printf '{
  "build": {
    "devUrl": "http://localhost:%s",
    "beforeDevCommand": "pnpm exec vite --host 0.0.0.0 --port %s --strictPort"
  },
  "bundle": {
    "icon": [
      "icons/icon-dev.icns",
      "icons/icon.png"
    ]
  }
}
' "$WEWORK_PORT" "$WEWORK_PORT" > "$TAURI_DEV_CONFIG"

echo "Starting WeWork mac app"
echo "  WEWORK_PORT=$WEWORK_PORT"
if [ "$WEWORK_PORT" != "$REQUESTED_WEWORK_PORT" ]; then
  echo "  requested WEWORK_PORT=$REQUESTED_WEWORK_PORT was in use"
fi
echo "  VITE_API_BASE_URL=${VITE_API_BASE_URL:-<proxy /api>}"
echo "  VITE_SOCKET_BASE_URL=${VITE_SOCKET_BASE_URL:-<proxy /socket.io>}"
echo "  VITE_API_PROXY_TARGET=$VITE_API_PROXY_TARGET"
echo "  VITE_SOCKET_PROXY_TARGET=$VITE_SOCKET_PROXY_TARGET"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  echo "  TAURI_DEV_CONFIG=$TAURI_DEV_CONFIG"
  cat "$TAURI_DEV_CONFIG"
  exit 0
fi

cd "$WEWORK_DIR"
exec pnpm exec tauri dev --config "$TAURI_DEV_CONFIG"
