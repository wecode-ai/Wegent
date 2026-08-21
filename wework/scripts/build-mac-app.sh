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

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"
# shellcheck source=lib/wework-mac-env.sh
source "$SCRIPT_DIR/lib/wework-mac-env.sh"
# shellcheck source=lib/wework-branding.sh
source "$SCRIPT_DIR/lib/wework-branding.sh"
# shellcheck source=lib/wework-macos-signing.sh
source "$SCRIPT_DIR/lib/wework-macos-signing.sh"
# shellcheck source=lib/wework-macos-sidecar.sh
source "$SCRIPT_DIR/lib/wework-macos-sidecar.sh"
# shellcheck source=lib/codex-code-statistics.sh
source "$SCRIPT_DIR/lib/codex-code-statistics.sh"

BUILD_PROFILE="${WEWORK_BUILD_PROFILE:-release}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-}"
TAURI_BUNDLES="${WEWORK_TAURI_BUNDLES:-}"
NO_SIGN="${WEWORK_NO_SIGN:-}"
RELEASE_DEVTOOLS="${WEWORK_RELEASE_DEVTOOLS:-1}"
BRAND_CONFIG="${WEWORK_BRAND_CONFIG:-}"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-mac-app.sh [options]

Options:
  --profile <dev|release>  Build profile. Default: release.
  --target <target>        macOS Rust/Tauri target, e.g. aarch64-apple-darwin.
  --bundles <bundles>      Tauri bundles to package, e.g. app or app,dmg.
  --devtools               Enable Web Inspector support (enabled by default).
  --brand-config <path>    Brand identity JSON used for this app bundle.
  --sign                   Allow signing in dev profile.
  --no-sign                Skip code signing.
  -h, --help               Show this help message.

Environment:
  WEWORK_BUILD_PROFILE     Default profile when --profile is not provided.
  MACOS_BUILD_TARGET       Default macOS Rust/Tauri target.
  WEWORK_TAURI_BUNDLES     Default bundle list when --bundles is not provided.
  WEWORK_RELEASE_DEVTOOLS  Set to 0 to omit Web Inspector support.
  WEWORK_BRAND_CONFIG      Default brand identity JSON.
  WEWORK_NO_SIGN           Set to 1 to pass --no-sign.
  VITE_WEGENT_BACKEND_URL  Default Backend URL shown in Connect cloud.
  VITE_WEGENT_SOCKET_URL   Optional Socket.IO origin; defaults to the Backend URL.
  VITE_WEWORK_FEEDBACK_URL Optional feedback submission endpoint. Disabled when empty.

Examples:
  bash wework/scripts/build-mac-app.sh --profile dev --target aarch64-apple-darwin
  bash wework/scripts/build-mac-app.sh --target aarch64-apple-darwin
  WEWORK_RELEASE_DEVTOOLS=0 bash wework/scripts/build-mac-app.sh --target aarch64-apple-darwin
EOF
}

notarize_built_macos_dmgs() {
  local build_started_at="$1"
  if [ "$NO_SIGN" = "1" ]; then
    return 0
  fi
  if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_PASSWORD:-}" ] \
    || [ -z "${APPLE_TEAM_ID:-}" ]; then
    return 0
  fi

  local profile_dir="release"
  if [ "$BUILD_PROFILE" = "dev" ]; then
    profile_dir="debug"
  fi

  local bundle_root="${CARGO_TARGET_DIR:-$WEWORK_DIR/src-tauri/target}"
  if [ -n "$MACOS_BUILD_TARGET" ]; then
    bundle_root="$bundle_root/$MACOS_BUILD_TARGET"
  fi

  local dmg dmg_dir="$bundle_root/$profile_dir/bundle/dmg"
  [ -d "$dmg_dir" ] || return 0
  while IFS= read -r -d '' dmg; do
    [ "$(stat -f '%m' "$dmg")" -ge "$build_started_at" ] || continue
    echo "Notarizing DMG: $dmg"
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_PASSWORD" \
      --wait
    xcrun stapler staple "$dmg"
  done < <(find "$dmg_dir" -type f -name '*.dmg' -print0)
}

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

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
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
echo "  VITE_WEWORK_FEEDBACK_URL=${VITE_WEWORK_FEEDBACK_URL:-<disabled>}"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"
if [ "${WEWORK_ENABLE_DEVTOOLS:-}" = "1" ]; then
  echo "  WEWORK_ENABLE_DEVTOOLS=1"
fi

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  if [ "${WEWORK_ENABLE_DEVTOOLS:-}" = "1" ]; then
    echo "  DRY RUN: pnpm exec tauri build ... --features devtools"
  else
    echo "  DRY RUN: pnpm exec tauri build ..."
  fi
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
BRAND_INPUT_CONFIG=""
cleanup() {
  if [ -n "$CONFIG_OVERRIDE" ]; then
    rm -f "$CONFIG_OVERRIDE"
    rm -f "$CONFIG_OVERRIDE.namespace"
  fi
  if [ -n "$BRAND_INPUT_CONFIG" ]; then
    rm -f "$BRAND_INPUT_CONFIG"
  fi
}
trap cleanup EXIT

CONFIG_OVERRIDE="$(mktemp "$WEWORK_DIR/src-tauri/tauri.build.json.XXXXXX")"
HOOK_RESOURCES="$(wework_code_statistics_macos_resources "$MACOS_BUILD_TARGET")" \
MACOS_BUILD_TARGET="$MACOS_BUILD_TARGET" \
CONFIG_OVERRIDE="$CONFIG_OVERRIDE" \
python3 - <<'PY'
import json
import os

build_target = os.environ["MACOS_BUILD_TARGET"]
codex_targets = (
    ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    if build_target in {"", "universal-apple-darwin"}
    else [build_target]
)
config = {
    "bundle": {
        "resources": [
            *(f"binaries/codex/{target}/**/*" for target in codex_targets),
            "binaries/codex/legal/**/*",
            "bundled-plugins",
            *os.environ["HOOK_RESOURCES"].splitlines(),
        ]
    }
}
with open(os.environ["CONFIG_OVERRIDE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY

TAURI_ARGS=(build)
if [ "$BUILD_PROFILE" = "dev" ]; then
  TAURI_ARGS+=(--debug)
fi
if [ -n "$BRAND_CONFIG" ]; then
  BRAND_INPUT_CONFIG="$CONFIG_OVERRIDE"
  CONFIG_OVERRIDE="$(mktemp "$WEWORK_DIR/src-tauri/tauri.build.json.XXXXXX")"
  wework_prepare_brand_config \
    "$WEWORK_DIR" "$BRAND_CONFIG" "0" "$CONFIG_OVERRIDE" "$BRAND_INPUT_CONFIG"
  if [ -f "$CONFIG_OVERRIDE.namespace" ]; then
    export WEWORK_EXECUTOR_NAMESPACE="$(<"$CONFIG_OVERRIDE.namespace")"
    rm -f "$CONFIG_OVERRIDE.namespace"
  fi
fi
TAURI_ARGS+=(--config "$CONFIG_OVERRIDE")
if [ "$RELEASE_DEVTOOLS" = "1" ]; then
  TAURI_ARGS+=(--features release-devtools)
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
if [ "${WEWORK_ENABLE_DEVTOOLS:-}" = "1" ]; then
  TAURI_ARGS+=(--features devtools)
fi

wework_build_macos_executor_sidecar \
  "$PROJECT_DIR" \
  "$WEWORK_DIR" \
  "$MACOS_BUILD_TARGET" \
  "$BUILD_PROFILE"
wework_build_code_statistics_hook "$WEWORK_DIR" "$MACOS_BUILD_TARGET"
if [ "$NO_SIGN" != "1" ]; then
  wework_sign_code_statistics_hook \
    "$WEWORK_DIR" \
    "$MACOS_BUILD_TARGET" \
    "${APPLE_SIGNING_IDENTITY:-}"
fi
WEWORK_CODEX_MATERIALIZE=1 WEWORK_CODEX_TARGET="${MACOS_BUILD_TARGET:-}" pnpm run prepare:codex
WEWORK_DWS_TARGET="${MACOS_BUILD_TARGET:-}" pnpm run prepare:dws
wework_sign_prepared_codex_macos_binaries \
  "$WEWORK_DIR" \
  "$MACOS_BUILD_TARGET" \
  "${APPLE_SIGNING_IDENTITY:-}" \
  "$NO_SIGN"
BUILD_STARTED_AT="$(date +%s)"
pnpm exec tauri "${TAURI_ARGS[@]}"
profile_dir="release"
if [ "$BUILD_PROFILE" = "dev" ]; then
  profile_dir="debug"
fi
tauri_target_root="${CARGO_TARGET_DIR:-$WEWORK_DIR/src-tauri/target}"
if [ -n "$MACOS_BUILD_TARGET" ]; then
  tauri_target_root="$tauri_target_root/$MACOS_BUILD_TARGET"
fi
wework_verify_macos_app_executor_sidecar "$tauri_target_root/$profile_dir/bundle"
wework_verify_code_statistics_hook \
  "$tauri_target_root/$profile_dir/bundle" \
  "$MACOS_BUILD_TARGET"
notarize_built_macos_dmgs "$BUILD_STARTED_AT"
