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

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Load .env.production first — it has production-specific overrides
PROD_ENV_FILE="$WEWORK_DIR/.env.production"
if [ -f "$PROD_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROD_ENV_FILE"
  set +a
fi

if [ -n "$EXPLICIT_VITE_API_BASE_URL" ]; then
  export VITE_API_BASE_URL="$EXPLICIT_VITE_API_BASE_URL_VALUE"
fi

if [ -n "$EXPLICIT_VITE_SOCKET_BASE_URL" ]; then
  export VITE_SOCKET_BASE_URL="$EXPLICIT_VITE_SOCKET_BASE_URL_VALUE"
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

echo "Building WeWork mac app"
echo "  BACKEND_PORT=$BACKEND_PORT (default URL only)"
echo "  VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "  VITE_SOCKET_BASE_URL=$VITE_SOCKET_BASE_URL"
if [ "${WEWORK_ENABLE_DEVTOOLS:-}" = "1" ]; then
  echo "  WEWORK_ENABLE_DEVTOOLS=1"
fi

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  if [ "${WEWORK_ENABLE_DEVTOOLS:-}" = "1" ]; then
    echo "  DRY RUN: pnpm exec tauri build --features devtools"
  else
    echo "  DRY RUN: pnpm run tauri:build"
  fi
  exit 0
fi

cd "$WEWORK_DIR"
if [ "${WEWORK_ENABLE_DEVTOOLS:-}" = "1" ]; then
  exec pnpm exec tauri build --features devtools
fi

exec pnpm run tauri:build
