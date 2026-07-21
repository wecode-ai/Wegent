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
# shellcheck source=lib/wework-branding.sh
source "$SCRIPT_DIR/lib/wework-branding.sh"
# shellcheck source=lib/wework-macos-signing.sh
source "$SCRIPT_DIR/lib/wework-macos-signing.sh"

BUILD_PROFILE="${WEWORK_BUILD_PROFILE:-release}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-}"
TAURI_BUNDLES="${WEWORK_TAURI_BUNDLES:-}"
NO_SIGN="${WEWORK_NO_SIGN:-}"
RELEASE_DEVTOOLS="${WEWORK_RELEASE_DEVTOOLS:-}"
BRAND_CONFIG="${WEWORK_BRAND_CONFIG:-}"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-mac-app.sh [options]

Options:
  --profile <dev|release>  Build profile. Default: release.
  --target <target>        macOS Rust/Tauri target, e.g. aarch64-apple-darwin.
  --bundles <bundles>      Tauri bundles to package, e.g. app or app,dmg.
  --devtools               Enable Web Inspector support in release builds.
  --brand-config <path>    Brand identity JSON used for this app bundle.
  --sign                   Allow signing in dev profile.
  --no-sign                Skip code signing.
  -h, --help               Show this help message.

Environment:
  WEWORK_BUILD_PROFILE     Default profile when --profile is not provided.
  MACOS_BUILD_TARGET       Default macOS Rust/Tauri target.
  WEWORK_TAURI_BUNDLES     Default bundle list when --bundles is not provided.
  WEWORK_RELEASE_DEVTOOLS  Set to 1 to compile Tauri devtools into release builds.
  WEWORK_BRAND_CONFIG      Default brand identity JSON.
  WEWORK_NO_SIGN           Set to 1 to pass --no-sign.
  VITE_WEGENT_BACKEND_URL  Default Backend URL shown in Connect cloud.
  VITE_WEGENT_SOCKET_URL   Optional Socket.IO origin; defaults to the Backend URL.

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
    --brand-config)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a config path." >&2
        usage
        exit 1
      fi
      BRAND_CONFIG="$2"
      shift 2
      ;;
    --brand-config=*)
      BRAND_CONFIG="${1#*=}"
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

if [ -n "$BRAND_CONFIG" ]; then
  if [ ! -f "$BRAND_CONFIG" ]; then
    echo "Error: brand config not found: $BRAND_CONFIG" >&2
    exit 1
  fi
  BRAND_CONFIG="$(cd "$(dirname "$BRAND_CONFIG")" && pwd)/$(basename "$BRAND_CONFIG")"
fi

if [ "$BUILD_PROFILE" = "dev" ]; then
  TAURI_BUNDLES="${TAURI_BUNDLES:-app}"
  NO_SIGN="${NO_SIGN:-1}"
fi

BACKEND_BASE_URL="$(wework_resolve_backend_base_url)"
BACKEND_PORT="${BACKEND_PORT:-9100}"

export VITE_WEGENT_BACKEND_URL="${VITE_WEGENT_BACKEND_URL:-$BACKEND_BASE_URL}"
configure_wegent_cargo_target_dir "$PROJECT_DIR" "wework-src-tauri"

echo "Building WeWork mac app"
echo "  PROFILE=$BUILD_PROFILE"
echo "  BACKEND_PORT=$BACKEND_PORT"
echo "  MACOS_BUILD_TARGET=${MACOS_BUILD_TARGET:-<native>}"
echo "  TAURI_BUNDLES=${TAURI_BUNDLES:-<default>}"
echo "  RELEASE_DEVTOOLS=${RELEASE_DEVTOOLS:-0}"
echo "  BRAND_CONFIG=${BRAND_CONFIG:-<default>}"
echo "  NO_SIGN=${NO_SIGN:-0}"
echo "  VITE_WEGENT_BACKEND_URL=$VITE_WEGENT_BACKEND_URL"
echo "  VITE_WEGENT_SOCKET_URL=${VITE_WEGENT_SOCKET_URL:-<backend URL>}"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  exit 0
fi

EXECUTOR_DIR="$PROJECT_DIR/executor"
EXECUTOR_PROFILE_DIR="debug"
EXECUTOR_BINARY_DIR="$(cargo_target_dir_for "$EXECUTOR_DIR")"

if [ "$BUILD_PROFILE" = "release" ]; then
  EXECUTOR_PROFILE_DIR="release"
fi
if [ -n "$MACOS_BUILD_TARGET" ]; then
  EXECUTOR_BINARY_DIR="$EXECUTOR_BINARY_DIR/$MACOS_BUILD_TARGET"
fi

echo "Building local executor sidecar"
cd "$EXECUTOR_DIR"
if [ -n "$MACOS_BUILD_TARGET" ]; then
  cargo build --profile "$BUILD_PROFILE" --locked --target "$MACOS_BUILD_TARGET"
else
  cargo build --profile "$BUILD_PROFILE" --locked
fi
mkdir -p "$EXECUTOR_DIR/dist"
cp "$EXECUTOR_BINARY_DIR/$EXECUTOR_PROFILE_DIR/wegent-executor" \
  "$EXECUTOR_DIR/dist/wegent-executor"
chmod 0755 "$EXECUTOR_DIR/dist/wegent-executor"
"$EXECUTOR_DIR/dist/wegent-executor" --version

cd "$WEWORK_DIR"
CONFIG_OVERRIDE=""
cleanup() {
  if [ -n "$CONFIG_OVERRIDE" ]; then
    rm -f "$CONFIG_OVERRIDE"
    rm -f "$CONFIG_OVERRIDE.namespace"
  fi
}
trap cleanup EXIT

TAURI_ARGS=(build)
if [ "$BUILD_PROFILE" = "dev" ]; then
  TAURI_ARGS+=(--debug)
fi
if [ -n "$BRAND_CONFIG" ] || [ "$RELEASE_DEVTOOLS" = "1" ]; then
  CONFIG_OVERRIDE="$(mktemp "$WEWORK_DIR/src-tauri/tauri.build.XXXXXX.json")"
  wework_prepare_brand_config "$WEWORK_DIR" "$BRAND_CONFIG" "${RELEASE_DEVTOOLS:-0}" "$CONFIG_OVERRIDE"
  if [ -f "$CONFIG_OVERRIDE.namespace" ]; then
    export WEWORK_EXECUTOR_NAMESPACE="$(<"$CONFIG_OVERRIDE.namespace")"
    rm -f "$CONFIG_OVERRIDE.namespace"
  fi
  if [ "$RELEASE_DEVTOOLS" = "1" ]; then
    TAURI_ARGS+=(--features release-devtools)
  fi
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
wework_sign_prepared_codex_macos_binaries \
  "$WEWORK_DIR" \
  "$MACOS_BUILD_TARGET" \
  "${APPLE_SIGNING_IDENTITY:-}" \
  "$NO_SIGN"
exec pnpm exec tauri "${TAURI_ARGS[@]}"
