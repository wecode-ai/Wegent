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
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-}"
TAURI_BUNDLES="${WEWORK_TAURI_BUNDLES:-}"
NO_SIGN="${WEWORK_NO_SIGN:-}"
RELEASE_DEVTOOLS="${WEWORK_RELEASE_DEVTOOLS:-}"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-mac-app.sh [options]

Options:
  --profile <dev|release>  Build profile. Default: release.
  --target <target>        macOS Rust/Tauri target, e.g. aarch64-apple-darwin.
  --bundles <bundles>      Tauri bundles to package, e.g. app or app,dmg.
  --devtools               Enable Web Inspector support in release builds.
  --sign                   Allow signing in dev profile.
  --no-sign                Skip code signing.
  -h, --help               Show this help message.

Environment:
  WEWORK_BUILD_PROFILE     Default profile when --profile is not provided.
  MACOS_BUILD_TARGET       Default macOS Rust/Tauri target.
  WEWORK_TAURI_BUNDLES     Default bundle list when --bundles is not provided.
  WEWORK_RELEASE_DEVTOOLS  Set to 1 to compile Tauri devtools into release builds.
  WEWORK_NO_SIGN           Set to 1 to pass --no-sign.

Examples:
  bash wework/scripts/build-mac-app.sh --profile dev --target aarch64-apple-darwin
  bash wework/scripts/build-mac-app.sh --target aarch64-apple-darwin
  WEWORK_RELEASE_DEVTOOLS=1 bash wework/scripts/build-mac-app.sh --target aarch64-apple-darwin
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
      MACOS_BUILD_TARGET="$2"
      shift 2
      ;;
    --target=*)
      MACOS_BUILD_TARGET="${1#*=}"
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
    --sign)
      NO_SIGN="0"
      shift
      ;;
    --no-sign)
      NO_SIGN="1"
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

if [ "$BUILD_PROFILE" = "dev" ]; then
  TAURI_BUNDLES="${TAURI_BUNDLES:-app}"
  NO_SIGN="${NO_SIGN:-1}"
fi

BACKEND_BASE_URL="$(wework_resolve_backend_base_url)"
BACKEND_PORT="${BACKEND_PORT:-9100}"
DEFAULT_SOCKET_BASE_URL="${WEGENT_SOCKET_URL:-$BACKEND_BASE_URL}"

export VITE_API_BASE_URL="${VITE_API_BASE_URL:-$BACKEND_BASE_URL/api}"
export VITE_SOCKET_BASE_URL="${VITE_SOCKET_BASE_URL:-$DEFAULT_SOCKET_BASE_URL}"
configure_wegent_cargo_target_dir "$PROJECT_DIR" "wework-src-tauri"

echo "Building WeWork mac app"
echo "  PROFILE=$BUILD_PROFILE"
echo "  BACKEND_PORT=$BACKEND_PORT"
echo "  MACOS_BUILD_TARGET=${MACOS_BUILD_TARGET:-<native>}"
echo "  TAURI_BUNDLES=${TAURI_BUNDLES:-<default>}"
echo "  RELEASE_DEVTOOLS=${RELEASE_DEVTOOLS:-0}"
echo "  NO_SIGN=${NO_SIGN:-0}"
echo "  VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "  VITE_SOCKET_BASE_URL=$VITE_SOCKET_BASE_URL"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  exit 0
fi

cd "$WEWORK_DIR"
CONFIG_OVERRIDE=""
cleanup() {
  if [ -n "$CONFIG_OVERRIDE" ]; then
    rm -f "$CONFIG_OVERRIDE"
  fi
}
trap cleanup EXIT

TAURI_ARGS=(build)
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
if [ -n "$MACOS_BUILD_TARGET" ]; then
  TAURI_ARGS+=(--target "$MACOS_BUILD_TARGET")
fi
if [ -n "$TAURI_BUNDLES" ]; then
  TAURI_ARGS+=(--bundles "$TAURI_BUNDLES")
fi
if [ "$NO_SIGN" = "1" ]; then
  TAURI_ARGS+=(--no-sign)
fi

WEWORK_CODEX_TARGET="${MACOS_BUILD_TARGET:-}" pnpm run prepare:codex
exec pnpm exec tauri "${TAURI_ARGS[@]}"
