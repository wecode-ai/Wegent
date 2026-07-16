#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
INITIAL_WEWORK_PORT="${WEWORK_PORT:-}"

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"
# shellcheck source=lib/wework-mac-env.sh
source "$SCRIPT_DIR/lib/wework-mac-env.sh"

MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-}"
WEWORK_RELEASE_UI="false"
EXECUTOR_ISOLATION_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/dev-mac-app.sh [options]

Options:
  -p, --port PORT       Vite/Tauri dev server port. Overrides WEWORK_PORT.
  --target TARGET       macOS Rust/Tauri target, e.g. aarch64-apple-darwin.
  --release-ui          Run a production frontend bundle through tauri dev.
  --shared-executor-home
                        Alias for --no-executor-isolation.
  --executor-isolation  Force an instance-specific Executor Home.
  --no-executor-isolation
                        Force direct use of WEGENT_EXECUTOR_HOME.
  -h, --help            Show this help message.

Environment:
  WEWORK_PORT           Default dev server port when --port is not provided.
  WEWORK_HOST           Host IP used to build backend proxy targets.
  BACKEND_PORT          Backend port used when proxy targets are not set.
  CARGO_TARGET_DIR      Explicit Cargo target directory. Overrides auto cache.
  WEGENT_CARGO_TARGET_ROOT
                        Root containing shared Cargo targets.
  WEGENT_DISABLE_SHARED_CARGO_TARGET
                        Set to 1 to keep Cargo's default per-worktree target.
  WEGENT_DISABLE_SCCACHE
                        Set to 1 to disable automatic sccache detection.
  WEWORK_EXECUTOR_SIDECAR
                        Executor sidecar path. Defaults to source reload sidecar.
  WEGENT_EXECUTOR_DEV_RELOAD
                        Set to 0 to run executor source once without reload.
  WEWORK_SHARED_EXECUTOR_HOME
                        Set to 1 to use the normal executor home in debug builds.
  WEWORK_MALLOC_STACK_LOGGING
                        Set to 1 to enable macOS malloc stack logging for WebKit diagnostics.
  MACOS_BUILD_TARGET    Default macOS Rust/Tauri target when --target is not provided.

Examples:
  bash wework/scripts/dev-mac-app.sh --port 9130
  bash wework/scripts/dev-mac-app.sh --shared-executor-home
  bash wework/scripts/dev-mac-app.sh --no-executor-isolation
  bash wework/scripts/dev-mac-app.sh --release-ui --target aarch64-apple-darwin
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
    --)
      shift
      ;;
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
    --target)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a target value." >&2
        usage
        exit 1
      fi
      MACOS_BUILD_TARGET="$2"
      shift 2
      ;;
    --target=*)
      MACOS_BUILD_TARGET="${1#*=}"
      shift
      ;;
    --release-ui)
      WEWORK_RELEASE_UI="true"
      shift
      ;;
    --executor-isolation)
      if [ "$EXECUTOR_ISOLATION_OVERRIDE" = "false" ]; then
        echo "Error: --executor-isolation and shared executor options are mutually exclusive." >&2
        exit 1
      fi
      EXECUTOR_ISOLATION_OVERRIDE="true"
      shift
      ;;
    --shared-executor-home|--no-executor-isolation)
      if [ "$EXECUTOR_ISOLATION_OVERRIDE" = "true" ]; then
        echo "Error: --executor-isolation and shared executor options are mutually exclusive." >&2
        exit 1
      fi
      EXECUTOR_ISOLATION_OVERRIDE="false"
      if [ "$1" = "--shared-executor-home" ]; then
        export WEWORK_SHARED_EXECUTOR_HOME=1
      fi
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

if [ -n "$EXECUTOR_ISOLATION_OVERRIDE" ]; then
  export WEWORK_EXECUTOR_ISOLATION_OVERRIDE="$EXECUTOR_ISOLATION_OVERRIDE"
else
  unset WEWORK_EXECUTOR_ISOLATION_OVERRIDE
fi

BACKEND_BASE_URL="$(wework_resolve_backend_base_url)"
BACKEND_PORT="${BACKEND_PORT:-9100}"
WEWORK_PORT="${REQUESTED_WEWORK_PORT:-${WEWORK_PORT:-1420}}"

if ! [[ "$WEWORK_PORT" =~ ^[0-9]+$ ]] || [ "$WEWORK_PORT" -lt 1 ] || [ "$WEWORK_PORT" -gt 65535 ]; then
  echo "Error: WEWORK_PORT must be a number between 1 and 65535. Got: $WEWORK_PORT" >&2
  exit 1
fi

is_port_available() {
  node - "$1" <<'NODE'
const net = require('node:net')
const port = Number(process.argv[2])

const canListen = host =>
  new Promise(resolve => {
    const server = net.createServer()

    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })

;(async () => {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    if (!(await canListen(host))) {
      process.exit(1)
    }
  }
})()
NODE
}

find_available_wework_port() {
  local port="$1"

  while [ "$port" -le 65535 ]; do
    if is_port_available "$port"; then
      echo "$port"
      return 0
    fi
    port="$((port + 1))"
  done

  echo "Error: no available WEWORK_PORT found from $1 to 65535." >&2
  return 1
}

git_branch_name() {
  git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
}

basename_or_path() {
  local path="$1"

  basename "$path" 2>/dev/null || echo "$path"
}

build_wework_dev_title() {
  local parent_title="${WEWORK_PARENT_TITLE:-}"
  local branch
  local worktree_name

  if [ -n "$parent_title" ]; then
    echo "$parent_title"
    return 0
  fi

  branch="$(git_branch_name)"
  worktree_name="$(basename_or_path "$PROJECT_DIR")"
  if [ -n "$branch" ]; then
    echo "$branch"
    return 0
  fi

  echo "$worktree_name"
}

AVAILABLE_WEWORK_PORT="$(find_available_wework_port "$WEWORK_PORT")"
if [ "$AVAILABLE_WEWORK_PORT" != "$WEWORK_PORT" ]; then
  echo "WEWORK_PORT $WEWORK_PORT is already in use; using $AVAILABLE_WEWORK_PORT instead."
fi
WEWORK_PORT="$AVAILABLE_WEWORK_PORT"

export WEWORK_DEV_WORKTREE="$PROJECT_DIR"
export WEWORK_DEV_BRANCH="$(git_branch_name)"
export WEWORK_DEV_PORT="$WEWORK_PORT"
export WEWORK_DEV_TITLE="$(build_wework_dev_title)"
export VITE_WEWORK_DEV_TITLE="$WEWORK_DEV_TITLE"
export VITE_WEWORK_DEV_PORT="$WEWORK_DEV_PORT"
export VITE_WEWORK_DEV_WORKTREE="$WEWORK_DEV_WORKTREE"
export VITE_WEWORK_DEV_BRANCH="$WEWORK_DEV_BRANCH"
export VITE_WEWORK_PARENT_TITLE="${WEWORK_PARENT_TITLE:-}"
export VITE_WEWORK_PARENT_PROJECT="${WEWORK_PARENT_PROJECT:-}"
export VITE_WEWORK_PARENT_WORKSPACE="${WEWORK_PARENT_WORKSPACE:-}"

export SKIP_FONT_DOWNLOAD="${SKIP_FONT_DOWNLOAD:-1}"
export VITE_API_PROXY_TARGET="$(wework_normalize_api_proxy_target "${VITE_API_PROXY_TARGET:-$BACKEND_BASE_URL}")"
export VITE_SOCKET_PROXY_TARGET="${VITE_SOCKET_PROXY_TARGET:-${WEGENT_SOCKET_URL:-$VITE_API_PROXY_TARGET}}"
if [ -z "${WEWORK_EXECUTOR_SIDECAR:-}" ]; then
  WEWORK_EXECUTOR_SIDECAR="$WEWORK_DIR/scripts/dev-executor-sidecar.sh"
fi
export WEWORK_EXECUTOR_SIDECAR

if [ "$WEWORK_RELEASE_UI" = "true" ]; then
  export VITE_API_BASE_URL="${VITE_API_BASE_URL:-$BACKEND_BASE_URL/api}"
  export VITE_SOCKET_BASE_URL="${VITE_SOCKET_BASE_URL:-${WEGENT_SOCKET_URL:-$BACKEND_BASE_URL}}"
  export VITE_SOCKET_PATH="${VITE_SOCKET_PATH:-/socket.io}"
  BEFORE_DEV_COMMAND="pnpm run build && pnpm exec vite preview --host 0.0.0.0 --port $WEWORK_PORT --strictPort"
else
  export VITE_API_BASE_URL="/api"
  export VITE_SOCKET_BASE_URL="http://localhost:$WEWORK_PORT"
  export VITE_SOCKET_PATH="${VITE_SOCKET_PATH:-/socket.io}"
  BEFORE_DEV_COMMAND="pnpm exec vite --host 0.0.0.0 --port $WEWORK_PORT --strictPort"
fi
install_wegent_sccache_with_homebrew
configure_wegent_cargo_target_dir "$PROJECT_DIR" "wework-src-tauri"

TAURI_DEV_CONFIG="$(mktemp -t wework-tauri-dev.XXXXXX.json)"
trap 'rm -f "$TAURI_DEV_CONFIG"' EXIT

WEWORK_PORT_VALUE="$WEWORK_PORT" \
BEFORE_DEV_COMMAND_VALUE="$BEFORE_DEV_COMMAND" \
WEWORK_RELEASE_UI_VALUE="$WEWORK_RELEASE_UI" \
TAURI_DEV_CONFIG_VALUE="$TAURI_DEV_CONFIG" \
python3 - <<'PY'
import json
import os

config = {
    "build": {
        "devUrl": f"http://localhost:{os.environ['WEWORK_PORT_VALUE']}",
        "beforeDevCommand": os.environ["BEFORE_DEV_COMMAND_VALUE"],
    },
}

if os.environ["WEWORK_RELEASE_UI_VALUE"] != "true":
    config["bundle"] = {
        "icon": [
            "icons/icon-dev.icns",
            "icons/icon.png",
        ],
    }

with open(os.environ["TAURI_DEV_CONFIG_VALUE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY

echo "Starting WeWork mac app"
echo "  RELEASE_UI=$WEWORK_RELEASE_UI"
echo "  WEWORK_PORT=$WEWORK_PORT"
echo "  WEWORK_DEV_TITLE=$WEWORK_DEV_TITLE"
echo "  WEWORK_DEV_WORKTREE=$WEWORK_DEV_WORKTREE"
echo "  WEWORK_DEV_BRANCH=${WEWORK_DEV_BRANCH:-<detached>}"
echo "  MACOS_BUILD_TARGET=${MACOS_BUILD_TARGET:-<native>}"
echo "  VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "  VITE_SOCKET_BASE_URL=$VITE_SOCKET_BASE_URL"
echo "  VITE_SOCKET_PATH=$VITE_SOCKET_PATH"
echo "  VITE_API_PROXY_TARGET=$VITE_API_PROXY_TARGET"
echo "  VITE_SOCKET_PROXY_TARGET=$VITE_SOCKET_PROXY_TARGET"
echo "  WEWORK_EXECUTOR_SIDECAR=${WEWORK_EXECUTOR_SIDECAR:-<bundled sidecar>}"
echo "  WEWORK_SHARED_EXECUTOR_HOME=${WEWORK_SHARED_EXECUTOR_HOME:-0}"
echo "  EXECUTOR_ISOLATION=${EXECUTOR_ISOLATION_OVERRIDE:-auto}"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${WEWORK_MALLOC_STACK_LOGGING:-}" = "1" ]; then
  export MallocStackLogging=1
  export MallocStackLoggingNoCompact=1
  echo "  MallocStackLogging=1"
  echo "  MallocStackLoggingNoCompact=1"
fi

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  echo "  TAURI_DEV_CONFIG=$TAURI_DEV_CONFIG"
  cat "$TAURI_DEV_CONFIG"
  exit 0
fi

cd "$WEWORK_DIR"
TAURI_ARGS=(dev --config "$TAURI_DEV_CONFIG")
if [ "$WEWORK_RELEASE_UI" = "true" ]; then
  TAURI_ARGS+=(--release)
fi
if [ -n "$MACOS_BUILD_TARGET" ]; then
  TAURI_ARGS+=(--target "$MACOS_BUILD_TARGET")
fi
exec pnpm exec tauri "${TAURI_ARGS[@]}"
