#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
EXECUTOR_ISOLATION="false"
ELECTRON_ARGS=()
ISOLATED_EXECUTOR_HOME=""
MANAGED_SOURCE_EXECUTOR="false"
MANAGED_DWS_BINARY="false"
MANAGED_HARNESS_RUNTIME="false"
WEWORK_APP_WATCH_PID=""
WEWORK_APP_WATCH_READY_FILE=""

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"
# shellcheck source=lib/wework-mac-env.sh
source "$SCRIPT_DIR/lib/wework-mac-env.sh"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/dev-mac-app.sh [options] [-- electron-options]

Options:
  --executor-isolation      Use a temporary Executor Home for this launch.
  --shared-executor-home    Use the release app's Executor Home (default).
  --no-executor-isolation   Alias for --shared-executor-home.
  -h, --help                Show this help message.

Environment:
  VITE_WEGENT_BACKEND_URL          Backend URL. Defaults to WEWORK_HOST/BACKEND_PORT.
  WEWORK_USER_DATA_DIR             Electron user data. Defaults to a directory isolated by worktree.
  WEWORK_APP_IDENTIFIER            Application identity. Defaults to one isolated by worktree.
  WEWORK_DEV_EXECUTOR_PATH         Executor command. Defaults to the source sidecar.
  WEWORK_DEV_CACHE_ROOT            Shared immutable dev cache. Defaults to ~/Library/Caches/wegent.
  WEWORK_DEV_HARNESS_RUNTIME_ROOT  Harness runtime. Defaults to the worktree runtime.
  WEWORK_DEV_COMPONENT_RESOURCES   Component links. Defaults to the worktree dependency cache.
  WEWORK_DEV_EXECUTOR_TARGET_ROOT  Executor build root. Defaults to a worktree-isolated cache.
  WEWORK_DEV_CODEX_BINARY          Codex binary. Defaults to the repository-locked binary.
  WEWORK_DEV_DWS_BINARY            DWS binary. Defaults to the repository-prepared binary.
  WEWORK_DRY_RUN=1                 Print the resolved launch configuration without starting.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --executor-isolation)
      EXECUTOR_ISOLATION="true"
      shift
      ;;
    --shared-executor-home|--no-executor-isolation)
      EXECUTOR_ISOLATION="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      ELECTRON_ARGS=("$@")
      break
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Error: dev-mac-app.sh only supports macOS." >&2
  exit 1
fi

REQUESTED_EXECUTOR_ISOLATION="$EXECUTOR_ISOLATION"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
EXECUTOR_ISOLATION="$REQUESTED_EXECUTOR_ISOLATION"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command is unavailable: $1" >&2
    exit 1
  fi
}

git_branch_name() {
  git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
}

build_dev_title() {
  if [ -n "${WEWORK_PARENT_TITLE:-}" ]; then
    echo "$WEWORK_PARENT_TITLE"
    return
  fi
  if [ -n "$WEWORK_DEV_BRANCH" ]; then
    echo "$WEWORK_DEV_BRANCH"
    return
  fi
  basename "$PROJECT_DIR"
}

build_dev_instance_id() {
  node -e "
    const { createHash } = require('node:crypto')
    process.stdout.write(
      createHash('sha256').update(process.argv[1]).digest('hex').slice(0, 12)
    )
  " "$PROJECT_DIR"
}

configure_source_executor_target() {
  local target_root="${WEWORK_DEV_EXECUTOR_TARGET_ROOT:-}"

  unset CARGO_TARGET_DIR
  unset WEGENT_CARGO_TARGET_DIR_AUTO

  if [ -n "$target_root" ]; then
    export CARGO_TARGET_DIR="${target_root%/}/$WEWORK_DEV_INSTANCE_ID"
  elif [ "${WEGENT_DISABLE_SHARED_CARGO_TARGET:-0}" = "1" ]; then
    export CARGO_TARGET_DIR="$PROJECT_DIR/executor/target"
  else
    target_root="$(wegent_cargo_cache_root)"
    if [ -n "$target_root" ]; then
      export CARGO_TARGET_DIR="${target_root%/}/executor-dev/$WEWORK_DEV_INSTANCE_ID"
    else
      export CARGO_TARGET_DIR="$PROJECT_DIR/executor/target"
    fi
  fi

  mkdir -p "$CARGO_TARGET_DIR"
  configure_wegent_sccache "$PROJECT_DIR" "$CARGO_TARGET_DIR"
}

resolve_macos_target() {
  case "$(uname -m)" in
    arm64)
      echo "aarch64-apple-darwin"
      ;;
    x86_64)
      echo "x86_64-apple-darwin"
      ;;
    *)
      echo "Error: unsupported macOS architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

cleanup() {
  if [ -n "$WEWORK_APP_WATCH_PID" ] && kill -0 "$WEWORK_APP_WATCH_PID" 2>/dev/null; then
    kill "$WEWORK_APP_WATCH_PID" 2>/dev/null || true
    wait "$WEWORK_APP_WATCH_PID" 2>/dev/null || true
  fi
  if [ -n "$ISOLATED_EXECUTOR_HOME" ]; then
    rm -rf "$ISOLATED_EXECUTOR_HOME"
  fi
  if [ -n "$WEWORK_APP_WATCH_READY_FILE" ]; then
    rm -f "$WEWORK_APP_WATCH_READY_FILE"
  fi
}

trap cleanup EXIT

require_command git
require_command node
require_command pnpm
require_command cargo

MACOS_TARGET="$(resolve_macos_target)"
export WEWORK_DEV_WORKTREE="$PROJECT_DIR"
export WEWORK_DEV_BRANCH="$(git_branch_name)"
export WEWORK_DEV_TITLE="$(build_dev_title)"
export WEWORK_USER_DATA_DIR="$(
  node "$SCRIPT_DIR/resolve-dev-user-data.mjs" "$PROJECT_DIR" "${WEWORK_USER_DATA_DIR:-}"
)"
export VITE_WEWORK_DEV_TITLE="$WEWORK_DEV_TITLE"
export VITE_WEWORK_DEV_WORKTREE="$WEWORK_DEV_WORKTREE"
export VITE_WEWORK_DEV_BRANCH="$WEWORK_DEV_BRANCH"
export VITE_WEWORK_PARENT_TITLE="${WEWORK_PARENT_TITLE:-}"
export VITE_WEWORK_PARENT_PROJECT="${WEWORK_PARENT_PROJECT:-}"
export VITE_WEWORK_PARENT_WORKSPACE="${WEWORK_PARENT_WORKSPACE:-}"
WEWORK_DEV_INSTANCE_ID="$(build_dev_instance_id)"
export WEWORK_APP_IDENTIFIER="${WEWORK_APP_IDENTIFIER:-io.wecode.wework.dev.$WEWORK_DEV_INSTANCE_ID}"
export WEWORK_USER_DATA_DIR="${WEWORK_USER_DATA_DIR:-$HOME/Library/Application Support/io.wecode.wework.dev/$WEWORK_DEV_INSTANCE_ID}"
export VITE_WEGENT_BACKEND_URL="${VITE_WEGENT_BACKEND_URL:-$(wework_resolve_backend_base_url)}"
export VITE_WEWORK_RELEASE_CHANNEL="${VITE_WEWORK_RELEASE_CHANNEL:-development}"
export VITE_WEWORK_RUNTIME_MODE="${VITE_WEWORK_RUNTIME_MODE:-local-first}"
export ELECTRON_GET_USE_PROXY="${ELECTRON_GET_USE_PROXY:-true}"
unset WEGENT_EXECUTOR_BINARY
if [ -n "${WEWORK_DEV_EXECUTOR_PATH:-}" ]; then
  export WEWORK_EXECUTOR_PATH="$WEWORK_DEV_EXECUTOR_PATH"
else
  export WEWORK_EXECUTOR_PATH="$SCRIPT_DIR/dev-executor-sidecar.sh"
  MANAGED_SOURCE_EXECUTOR="true"
  configure_source_executor_target
  export WEGENT_EXECUTOR_BINARY="$(
    cargo_target_binary_path "$PROJECT_DIR/executor" debug wegent-executor
  )"
fi
export WEWORK_DEV_CACHE_ROOT="${WEWORK_DEV_CACHE_ROOT:-$HOME/Library/Caches/wegent/wework-dev}"
export WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT="${WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT:-$WEWORK_DEV_CACHE_ROOT/harness-runtime}"
if [ -n "${WEWORK_DEV_HARNESS_RUNTIME_ROOT:-}" ]; then
  export WEWORK_HARNESS_RUNTIME_ROOT="$WEWORK_DEV_HARNESS_RUNTIME_ROOT"
else
  export WEWORK_HARNESS_RUNTIME_ROOT="$WEWORK_DIR/node_modules/.cache/harness-runtime-dev"
  MANAGED_HARNESS_RUNTIME="true"
fi
export WEWORK_COMPONENT_RESOURCES_ROOT="${WEWORK_DEV_COMPONENT_RESOURCES:-$WEWORK_DIR/node_modules/.cache/wework-electron-dev-resources}"
export WEWORK_CORE_PLUGIN_ROOT="$WEWORK_COMPONENT_RESOURCES_ROOT/wework-core-plugins"
export WEWORK_APP_HOT_RELOAD="1"
export WEWORK_APP_WEB_ROOT="$WEWORK_DIR/dsh/app-wework/web"

if [ -n "${WEWORK_DEV_CODEX_BINARY:-}" ]; then
  export CODEX_BINARY_PATH="$WEWORK_DEV_CODEX_BINARY"
else
  export CODEX_BINARY_PATH="$WEWORK_DIR/resources/binaries/codex/$MACOS_TARGET/vendor/$MACOS_TARGET/bin/codex"
fi
if [ -n "${WEWORK_DEV_DWS_BINARY:-}" ]; then
  export DWS_BINARY_PATH="$WEWORK_DEV_DWS_BINARY"
else
  export DWS_BINARY_PATH="$WEWORK_DIR/resources/binaries/dws-$MACOS_TARGET"
  MANAGED_DWS_BINARY="true"
fi

if [ "$EXECUTOR_ISOLATION" = "true" ]; then
  ISOLATED_EXECUTOR_HOME="$(mktemp -d "${TMPDIR:-/tmp}/wework-dev-executor.XXXXXX")"
  export WEGENT_EXECUTOR_HOME="$ISOLATED_EXECUTOR_HOME"
fi

print_configuration() {
  echo "Starting Wework macOS app"
  echo "  WEWORK_DEV_TITLE=$WEWORK_DEV_TITLE"
  echo "  WEWORK_DEV_WORKTREE=$WEWORK_DEV_WORKTREE"
  echo "  WEWORK_DEV_BRANCH=${WEWORK_DEV_BRANCH:-<detached>}"
  echo "  WEWORK_APP_IDENTIFIER=$WEWORK_APP_IDENTIFIER"
  echo "  WEWORK_USER_DATA_DIR=$WEWORK_USER_DATA_DIR"
  echo "  VITE_WEGENT_BACKEND_URL=$VITE_WEGENT_BACKEND_URL"
  echo "  WEWORK_EXECUTOR_PATH=$WEWORK_EXECUTOR_PATH"
  echo "  WEGENT_EXECUTOR_BINARY=${WEGENT_EXECUTOR_BINARY:-<managed by command>}"
  echo "  WEGENT_EXECUTOR_HOME=${WEGENT_EXECUTOR_HOME:-<release app default>}"
  echo "  WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT=$WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT"
  echo "  WEWORK_HARNESS_RUNTIME_ROOT=$WEWORK_HARNESS_RUNTIME_ROOT"
  echo "  WEWORK_COMPONENT_RESOURCES_ROOT=$WEWORK_COMPONENT_RESOURCES_ROOT"
  echo "  WEWORK_CORE_PLUGIN_ROOT=$WEWORK_CORE_PLUGIN_ROOT"
  echo "  CODEX_BINARY_PATH=$CODEX_BINARY_PATH"
  echo "  DWS_BINARY_PATH=$DWS_BINARY_PATH"
}

print_configuration
if [ "${WEWORK_DRY_RUN:-0}" = "1" ]; then
  exit 0
fi

cd "$WEWORK_DIR"
node "$SCRIPT_DIR/prepare-dev-dependencies.mjs"
if [ ! -f resources/icons/32x32.png ]; then
  echo "Error: Electron development icons are unavailable." >&2
  exit 1
fi
if [ ! -f resources/bundled-plugins/wework-personal/.agents/plugins/marketplace.json ]; then
  echo "Error: Electron bundled plugins are unavailable." >&2
  exit 1
fi
if [ -z "${WEWORK_DEV_CODEX_BINARY:-}" ]; then
  WEWORK_CODEX_TARGET="$MACOS_TARGET" node "$SCRIPT_DIR/prepare-codex-binary.mjs"
fi
if [ "$MANAGED_DWS_BINARY" = "true" ]; then
  WEWORK_DWS_TARGET="$MACOS_TARGET" node "$SCRIPT_DIR/prepare-dws-binary.mjs"
fi
if [ "$MANAGED_HARNESS_RUNTIME" = "true" ]; then
  node "$SCRIPT_DIR/prepare-harness-runtime.mjs" --materialize
fi

if [ "$MANAGED_SOURCE_EXECUTOR" = "true" ]; then
  cargo build --manifest-path "$PROJECT_DIR/executor/Cargo.toml" --bin wegent-executor
fi
if [ ! -x "$WEWORK_EXECUTOR_PATH" ]; then
  echo "Error: Executor command is not executable: $WEWORK_EXECUTOR_PATH" >&2
  exit 1
fi
if [ ! -x "$CODEX_BINARY_PATH" ]; then
  echo "Error: Codex binary is not executable: $CODEX_BINARY_PATH" >&2
  exit 1
fi
if [ ! -x "$DWS_BINARY_PATH" ]; then
  echo "Error: DWS binary is not executable: $DWS_BINARY_PATH" >&2
  exit 1
fi
node "$SCRIPT_DIR/prepare-dev-component-resources.mjs"
if ! WEWORK_CORE_PLUGINS_SHA256="$(
  node -e "
    const manifest = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))
    process.stdout.write(manifest.components.weworkCorePlugins.sha256)
  " "$WEWORK_COMPONENT_RESOURCES_ROOT/components.json"
)"; then
  echo "Error: Failed to read core plugin checksum from component resources" >&2
  exit 1
fi
export WEWORK_CORE_PLUGINS_SHA256
WEWORK_APP_WATCH_READY_FILE="$(mktemp "${TMPDIR:-/tmp}/wework-app-watch.XXXXXX")"
rm -f "$WEWORK_APP_WATCH_READY_FILE"
export WEWORK_APP_WATCH_READY_FILE
node "$SCRIPT_DIR/dev-wework-app-watch.mjs" &
WEWORK_APP_WATCH_PID="$!"

for _ in $(seq 1 240); do
  if [ -s "$WEWORK_APP_WATCH_READY_FILE" ]; then
    break
  fi
  if ! kill -0 "$WEWORK_APP_WATCH_PID" 2>/dev/null; then
    wait "$WEWORK_APP_WATCH_PID" 2>/dev/null || true
    echo "Error: Original Wework application build watcher exited before becoming ready." >&2
    exit 1
  fi
  sleep 0.25
done
if [ ! -s "$WEWORK_APP_WATCH_READY_FILE" ]; then
  echo "Error: Original Wework application build watcher did not become ready." >&2
  exit 1
fi

# The parent Wework terminal may expose the release app's Electron-backed Node
# runtime. A source checkout must create its own Node launcher, while the
# desktop process itself must always start in Electron app mode.
unset ELECTRON_RUN_AS_NODE
unset WEWORK_NODE_PATH
unset WEWORK_NODE_RUNTIME_KIND
pnpm --dir electron run build
ELECTRON_BINARY="$WEWORK_DIR/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ "${#ELECTRON_ARGS[@]}" -gt 0 ]; then
  "$ELECTRON_BINARY" "$WEWORK_DIR/electron" "${ELECTRON_ARGS[@]}"
else
  "$ELECTRON_BINARY" "$WEWORK_DIR/electron"
fi
