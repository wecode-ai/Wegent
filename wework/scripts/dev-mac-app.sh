#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
INITIAL_WEWORK_PORT="${WEWORK_PORT:-}"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/dev-mac-app.sh [options]

Options:
  -p, --port PORT       Vite/Tauri dev server port. Overrides WEWORK_PORT.
  -h, --help            Show this help message.

Environment:
  WEWORK_PORT           Default dev server port when --port is not provided.
  WEWORK_HOST           Host IP used to build backend proxy targets.
  BACKEND_PORT          Backend port used when proxy targets are not set.
  WEWORK_EXECUTOR_SIDECAR
                        Executor sidecar path. Defaults to source reload sidecar.
  WEGENT_EXECUTOR_DEV_RELOAD
                        Set to 0 to run executor source once without reload.

Examples:
  bash wework/scripts/dev-mac-app.sh --port 9130
  WEWORK_PORT=9130 bash wework/scripts/dev-mac-app.sh
EOF
}

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -n "$INITIAL_WEWORK_PORT" ]; then
  WEWORK_PORT="$INITIAL_WEWORK_PORT"
fi

REQUESTED_WEWORK_PORT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--port)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a port value." >&2
        usage
        exit 1
      fi
      REQUESTED_WEWORK_PORT="$2"
      shift 2
      ;;
    --port=*)
      REQUESTED_WEWORK_PORT="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

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
WEWORK_PORT="${REQUESTED_WEWORK_PORT:-${WEWORK_PORT:-1420}}"

if ! [[ "$WEWORK_PORT" =~ ^[0-9]+$ ]] || [ "$WEWORK_PORT" -lt 1 ] || [ "$WEWORK_PORT" -gt 65535 ]; then
  echo "Error: WEWORK_PORT must be a number between 1 and 65535. Got: $WEWORK_PORT" >&2
  exit 1
fi

export VITE_API_PROXY_TARGET="${VITE_API_PROXY_TARGET:-http://$LOCAL_IP:$BACKEND_PORT}"
export VITE_SOCKET_PROXY_TARGET="${VITE_SOCKET_PROXY_TARGET:-${WEGENT_SOCKET_URL:-$VITE_API_PROXY_TARGET}}"
if [ -z "${WEWORK_EXECUTOR_SIDECAR:-}" ]; then
  WEWORK_EXECUTOR_SIDECAR="$WEWORK_DIR/scripts/dev-executor-sidecar.sh"
fi
export WEWORK_EXECUTOR_SIDECAR

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
echo "  WEWORK_EXECUTOR_SIDECAR=${WEWORK_EXECUTOR_SIDECAR:-<bundled sidecar>}"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  echo "  TAURI_DEV_CONFIG=$TAURI_DEV_CONFIG"
  cat "$TAURI_DEV_CONFIG"
  exit 0
fi

cd "$WEWORK_DIR"
exec pnpm exec tauri dev --config "$TAURI_DEV_CONFIG"
