#!/usr/bin/env bash

# Local development cloud device.
#
# Registers a real executor with the dev backend as a `device_type=cloud`
# device so project-space robot tasks can be dispatched to a "cloud device"
# on this machine for testing. The device id is stable (default
# `cloud-device-dev`), the auth token is minted from the local backend .env
# secret on every start, and the executor always runs the current source code
# (rebuilt when needed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$EXECUTOR_DIR/.." && pwd)"
WEWORK_DIR="$PROJECT_DIR/wework"
ENV_FILE="$PROJECT_DIR/.env"
BACKEND_ENV_FILE="$PROJECT_DIR/backend/.env"

COMMAND="${1:-start}"
DEVICE_ID="${DEVICE_ID:-cloud-device-dev}"
DEVICE_TYPE="${DEVICE_TYPE:-cloud}"
DEVICE_NAME="${DEVICE_NAME:-Local Dev Cloud Device}"
DEVICE_USER="${DEVICE_USER:-admin}"
DEVICE_USER_ID="${DEVICE_USER_ID:-1}"
BACKEND_URL="${WEGENT_BACKEND_URL:-http://localhost:8000}"
HOME_DIR="${CLOUD_DEVICE_HOME:-$HOME/.wegent-executor-cloud-device}"

usage() {
  cat <<'EOF'
Usage: bash executor/scripts/dev-cloud-device.sh [start|stop|status|restart]

Starts/keeps a local executor registered with the dev backend as a cloud
device (device_type=cloud) so cloud project-space robots can execute here.

Environment overrides:
  DEVICE_ID               Device id (default: cloud-device-dev)
  DEVICE_TYPE             Device type (default: cloud)
  DEVICE_USER             Backend user_name for the auth token (default: admin)
  DEVICE_USER_ID          Backend user id for the auth token (default: 1)
  WEGENT_BACKEND_URL      Dev backend URL (default: http://localhost:8000)
  CLOUD_DEVICE_HOME       Data/log dir (default: $HOME/.wegent-executor-cloud-device)
  CLOUD_DEVICE_EXECUTOR_BIN
                          Executor binary override (default: cargo build output)
EOF
}

if [ "$COMMAND" = "-h" ] || [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "help" ]; then
  usage
  exit 0
fi

mkdir -p "$HOME_DIR/executor-home" "$HOME_DIR/codex"
PID_FILE="$HOME_DIR/executor.pid"
LOG_FILE="$HOME_DIR/executor.log"

if [ -f "$BACKEND_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$BACKEND_ENV_FILE"
  set +a
fi

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

resolve_executor_binary() {
  if [ -n "${CLOUD_DEVICE_EXECUTOR_BIN:-}" ]; then
    printf '%s\n' "$CLOUD_DEVICE_EXECUTOR_BIN"
    return 0
  fi
  local target_dir="${CARGO_TARGET_DIR:-}"
  if [ -z "$target_dir" ]; then
    target_dir="$EXECUTOR_DIR/target"
  fi
  local bin="$target_dir/debug/wegent-executor"
  if [ ! -x "$bin" ] || [ -n "${CLOUD_DEVICE_REBUILD:-}" ]; then
    echo "Building executor (first run may take a while)..."
    (
      cd "$EXECUTOR_DIR"
      cargo build --bin wegent-executor
    )
  fi
  printf '%s\n' "$bin"
}

resolve_codex_binary() {
  local host
  host="$(rustc -vV | awk '$1 == "host:" { print $2 }')"
  local bin="$WEWORK_DIR/src-tauri/binaries/codex/$host/vendor/$host/bin/codex"
  if [ ! -x "$bin" ]; then
    echo "Error: prepared Codex binary missing at $bin" >&2
    echo "Run: pnpm --filter wework prepare:codex" >&2
    exit 1
  fi
  printf '%s\n' "$bin"
}

mint_token() {
  local secret="${SECRET_KEY:-}"
  if [ -z "$secret" ]; then
    echo "Error: SECRET_KEY not found in $BACKEND_ENV_FILE" >&2
    exit 1
  fi
  python3 - "$secret" "$DEVICE_USER" "$DEVICE_USER_ID" <<'PY'
import base64
import hashlib
import hmac
import json
import sys
import time

secret, user_name, user_id = sys.argv[1], sys.argv[2], int(sys.argv[3])

def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
payload = b64(
    json.dumps(
        {
            "sub": user_name,
            "user_id": user_id,
            "exp": int(time.time()) + 30 * 24 * 3600,
        }
    ).encode()
)
signing_input = f"{header}.{payload}"
signature = b64(
    hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
)
print(f"{signing_input}.{signature}")
PY
}

start() {
  if is_running; then
    echo "Cloud device already running (pid $(cat "$PID_FILE"))"
    status
    return 0
  fi

  if [ -z "${SECRET_KEY:-}" ]; then
    echo "Error: SECRET_KEY not found in $BACKEND_ENV_FILE" >&2
    exit 1
  fi

  local bin
  bin="$(resolve_executor_binary)"
  local codex_bin
  codex_bin="$(resolve_codex_binary)"
  local token
  token="$(mint_token)"

  echo "Starting cloud device $DEVICE_ID ($DEVICE_TYPE) -> $BACKEND_URL"
  : >"$LOG_FILE"
  (
    cd "$EXECUTOR_DIR"
    env \
      WEGENT_BACKEND_URL="$BACKEND_URL" \
      WEGENT_AUTH_TOKEN="$token" \
      DEVICE_ID="$DEVICE_ID" \
      DEVICE_TYPE="$DEVICE_TYPE" \
      DEVICE_NAME="$DEVICE_NAME" \
      WEGENT_EXECUTOR_HOME="$HOME_DIR/executor-home" \
      WEGENT_CODEX_HOME="$HOME_DIR/codex" \
      CODEX_HOME="$HOME_DIR/codex" \
      CODEX_BINARY_PATH="$codex_bin" \
      WEGENT_EXECUTOR_LOG_DIR="$HOME_DIR" \
      WEGENT_EXECUTOR_DEV_RELOAD=0 \
      python3 -c 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' "$bin" \
        >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_running; then
      echo "Error: executor exited during startup; see $LOG_FILE" >&2
      tail -40 "$LOG_FILE" >&2 || true
      exit 1
    fi
    local online=""
    if command -v redis-cli >/dev/null 2>&1; then
      online="$(redis-cli -h 127.0.0.1 -p 6379 EXISTS "device:online:1:$DEVICE_ID" 2>/dev/null || true)"
    fi
    if [ "$online" = "1" ] || grep -q "local backend registered" "$LOG_FILE" 2>/dev/null; then
      break
    fi
    sleep 2
  done

  local online=""
  if command -v redis-cli >/dev/null 2>&1; then
    online="$(redis-cli -h 127.0.0.1 -p 6379 EXISTS "device:online:1:$DEVICE_ID" 2>/dev/null || true)"
  fi
  if [ "$online" != "1" ] && ! grep -q "local backend registered" "$LOG_FILE" 2>/dev/null; then
    echo "Error: executor did not register with the backend in time; see $LOG_FILE" >&2
    exit 1
  fi
  echo "Cloud device is online."
  status
}

stop() {
  if ! is_running; then
    echo "Cloud device is not running."
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  echo "Stopping cloud device (pid $pid)..."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "Stopped."
}

status() {
  if is_running; then
    echo "Cloud device $DEVICE_ID: running (pid $(cat "$PID_FILE"))"
  else
    echo "Cloud device $DEVICE_ID: not running"
  fi
  echo "  home:   $HOME_DIR"
  echo "  log:    $LOG_FILE"
  if command -v redis-cli >/dev/null 2>&1; then
    echo "  online: $(redis-cli -h 127.0.0.1 -p 6379 EXISTS "device:online:${DEVICE_USER_ID}:$DEVICE_ID" 2>/dev/null || echo unknown)"
  fi
}

case "$COMMAND" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    usage
    exit 2
    ;;
esac
