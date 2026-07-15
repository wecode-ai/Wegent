#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"
# shellcheck source=lib/wework-mac-env.sh
source "$SCRIPT_DIR/lib/wework-mac-env.sh"

BUILD_PROFILE="${WEWORK_BUILD_PROFILE:-release}"
WINDOWS_BUILD_TARGET="${WINDOWS_BUILD_TARGET:-x86_64-pc-windows-msvc}"
TAURI_BUNDLES="${WEWORK_TAURI_BUNDLES:-nsis}"
RELEASE_DEVTOOLS="${WEWORK_RELEASE_DEVTOOLS:-}"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-windows-app.sh [options]

Options:
  --profile <dev|release>  Build profile. Default: release.
  --target <target>        Windows Rust/Tauri target, e.g. x86_64-pc-windows-msvc.
  --bundles <bundles>      Tauri bundles to package, e.g. nsis or nsis,msi.
  --devtools               Enable Web Inspector support in release builds.
  -h, --help               Show this help message.

Environment:
  WEWORK_BUILD_PROFILE      Default profile when --profile is not provided.
  WINDOWS_BUILD_TARGET      Default Windows Rust/Tauri target.
  WEWORK_TAURI_BUNDLES      Default bundle list when --bundles is not provided.
  WEWORK_RELEASE_DEVTOOLS   Set to 1 to compile Tauri devtools into release builds.

Examples:
  bash wework/scripts/build-windows-app.sh --profile dev
  bash wework/scripts/build-windows-app.sh --target x86_64-pc-windows-msvc
  WEWORK_RELEASE_DEVTOOLS=1 bash wework/scripts/build-windows-app.sh
EOF
}

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a profile value." >&2
        usage
        exit 1
      fi
      BUILD_PROFILE="$2"
      shift 2
      ;;
    --profile=*)
      BUILD_PROFILE="${1#*=}"
      shift
      ;;
    --target)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a target value." >&2
        usage
        exit 1
      fi
      WINDOWS_BUILD_TARGET="$2"
      shift 2
      ;;
    --target=*)
      WINDOWS_BUILD_TARGET="${1#*=}"
      shift
      ;;
    --bundles)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a bundle value." >&2
        usage
        exit 1
      fi
      TAURI_BUNDLES="$2"
      shift 2
      ;;
    --bundles=*)
      TAURI_BUNDLES="${1#*=}"
      shift
      ;;
    --devtools)
      RELEASE_DEVTOOLS="1"
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

if [ "$BUILD_PROFILE" != "dev" ] && [ "$BUILD_PROFILE" != "release" ]; then
  echo "Error: --profile must be 'dev' or 'release'. Got: $BUILD_PROFILE" >&2
  exit 1
fi

BACKEND_BASE_URL="$(wework_resolve_backend_base_url)"
BACKEND_PORT="${BACKEND_PORT:-9100}"
DEFAULT_SOCKET_BASE_URL="${WEGENT_SOCKET_URL:-$BACKEND_BASE_URL}"

export VITE_API_BASE_URL="${VITE_API_BASE_URL:-$BACKEND_BASE_URL/api}"
export VITE_SOCKET_BASE_URL="${VITE_SOCKET_BASE_URL:-$DEFAULT_SOCKET_BASE_URL}"
configure_wegent_cargo_target_dir "$PROJECT_DIR" "wework-src-tauri"

echo "Building WeWork Windows app"
echo "  PROFILE=$BUILD_PROFILE"
echo "  BACKEND_PORT=$BACKEND_PORT"
echo "  WINDOWS_BUILD_TARGET=$WINDOWS_BUILD_TARGET"
echo "  TAURI_BUNDLES=${TAURI_BUNDLES:-<default>}"
echo "  RELEASE_DEVTOOLS=${RELEASE_DEVTOOLS:-0}"
echo "  VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "  VITE_SOCKET_BASE_URL=$VITE_SOCKET_BASE_URL"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  exit 0
fi

EXECUTOR_DIR="$PROJECT_DIR/executor"
EXECUTOR_BINARY_NAME="wegent-executor.exe"
SIDE_CAR_NAME="wegent-executor-${WINDOWS_BUILD_TARGET}.exe"
SIDE_CAR_DIR="$WEWORK_DIR/src-tauri/binaries"

echo "Building local executor sidecar for $WINDOWS_BUILD_TARGET"
cd "$EXECUTOR_DIR"
RUSTFLAGS="-C target-feature=+crt-static" cargo xwin build --"$BUILD_PROFILE" --locked --target "$WINDOWS_BUILD_TARGET"

mkdir -p "$SIDE_CAR_DIR"
cp "$CARGO_TARGET_DIR/$WINDOWS_BUILD_TARGET/$BUILD_PROFILE/$EXECUTOR_BINARY_NAME" "$SIDE_CAR_DIR/$SIDE_CAR_NAME"

cd "$WEWORK_DIR"
CONFIG_OVERRIDE=""
cleanup() {
  if [ -n "$CONFIG_OVERRIDE" ]; then
    rm -f "$CONFIG_OVERRIDE"
  fi
}
trap cleanup EXIT

TAURI_ARGS=(build)
TAURI_ARGS+=(--runner cargo-xwin)
TAURI_ARGS+=(--target "$WINDOWS_BUILD_TARGET")
if [ "$BUILD_PROFILE" = "dev" ]; then
  TAURI_ARGS+=(--debug)
fi
if [ "$RELEASE_DEVTOOLS" = "1" ]; then
  CONFIG_OVERRIDE="$(mktemp "$WEWORK_DIR/src-tauri/tauri.devtools.XXXXXX.json")"
  CONFIG_OVERRIDE="$CONFIG_OVERRIDE" python3 - <<'PY'
import json
import os

with open("src-tauri/tauri.conf.json", "r", encoding="utf-8") as handle:
    base_config = json.load(handle)

windows = base_config.get("app", {}).get("windows", [])
config = {
    "app": {
        "windows": [
            {
                **window,
                "devtools": True,
            }
            for window in windows
        ],
    },
}

with open(os.environ["CONFIG_OVERRIDE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
  TAURI_ARGS+=(--features release-devtools)
  TAURI_ARGS+=(--config "$CONFIG_OVERRIDE")
fi
if [ -n "$TAURI_BUNDLES" ]; then
  TAURI_ARGS+=(--bundles "$TAURI_BUNDLES")
fi

WEWORK_CODEX_TARGET="$WINDOWS_BUILD_TARGET" pnpm run prepare:codex
pnpm exec tauri "${TAURI_ARGS[@]}"

# Patch the generated NSIS installer to create the desktop shortcut via COM.
# Tauri's default CreateShortcut can produce shortcuts with empty target/working
# directory fields, especially when the installation path contains Unicode
# characters or when cross-compiling from macOS.
CARGO_PROFILE_DIR="$BUILD_PROFILE"
if [ "$BUILD_PROFILE" = "dev" ]; then
  CARGO_PROFILE_DIR="debug"
fi
NSI_PATH="$CARGO_TARGET_DIR/$WINDOWS_BUILD_TARGET/$CARGO_PROFILE_DIR/nsis/x64/installer.nsi"
if [ -f "$NSI_PATH" ]; then
  echo "==> Patching NSIS desktop shortcut creation"
  python3 "$SCRIPT_DIR/patch-windows-nsis.py" "$NSI_PATH"

  BUNDLE_DIR="$CARGO_TARGET_DIR/$WINDOWS_BUILD_TARGET/$CARGO_PROFILE_DIR/bundle/nsis"
  echo "==> Windows installer bundle directory: $BUNDLE_DIR"
  ls -la "$BUNDLE_DIR"/*.exe 2>/dev/null || echo "warning: no .exe found in $BUNDLE_DIR" >&2
else
  echo "warning: generated NSIS not found at $NSI_PATH, skipping patch" >&2
fi
