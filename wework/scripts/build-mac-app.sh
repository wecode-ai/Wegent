#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"

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
BACKEND_BASE_URL="http://$LOCAL_IP:$BACKEND_PORT"
DEFAULT_SOCKET_BASE_URL="${WEGENT_SOCKET_URL:-$BACKEND_BASE_URL}"

export VITE_API_BASE_URL="${VITE_API_BASE_URL:-$BACKEND_BASE_URL/api}"
export VITE_SOCKET_BASE_URL="${VITE_SOCKET_BASE_URL:-$DEFAULT_SOCKET_BASE_URL}"
configure_wegent_cargo_target_dir "$PROJECT_DIR" "wework-src-tauri"

echo "Building WeWork mac app"
echo "  BACKEND_PORT=$BACKEND_PORT"
echo "  VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "  VITE_SOCKET_BASE_URL=$VITE_SOCKET_BASE_URL"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  exit 0
fi

cd "$WEWORK_DIR"
exec pnpm run tauri:build
