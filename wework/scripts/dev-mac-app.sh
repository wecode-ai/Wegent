#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
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

LOCAL_IP="${WEWORK_HOST:-$(get_local_ip)}"
BACKEND_PORT="${BACKEND_PORT:-9100}"
WEWORK_PORT="${WEWORK_PORT:-1420}"

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
echo "  VITE_API_PROXY_TARGET=$VITE_API_PROXY_TARGET"
echo "  VITE_SOCKET_PROXY_TARGET=$VITE_SOCKET_PROXY_TARGET"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  echo "  TAURI_DEV_CONFIG=$TAURI_DEV_CONFIG"
  cat "$TAURI_DEV_CONFIG"
  exit 0
fi

cd "$WEWORK_DIR"
exec pnpm exec tauri dev --config "$TAURI_DEV_CONFIG"
