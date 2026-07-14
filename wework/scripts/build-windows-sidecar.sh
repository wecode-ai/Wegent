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

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-windows-sidecar.sh [options]

Options:
  --profile <dev|release>  Build profile. Default: release.
  --target <target>        Windows Rust target, e.g. x86_64-pc-windows-msvc.
  -h, --help               Show this help message.

Environment:
  WEWORK_BUILD_PROFILE      Default profile when --profile is not provided.
  WINDOWS_BUILD_TARGET      Default Windows Rust target.

Examples:
  bash wework/scripts/build-windows-sidecar.sh --profile dev
  bash wework/scripts/build-windows-sidecar.sh --target x86_64-pc-windows-msvc
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

configure_wegent_cargo_target_dir "$PROJECT_DIR" "wework-windows-sidecar"

echo "Building WeWork local executor sidecar for $WINDOWS_BUILD_TARGET"
echo "  PROFILE=$BUILD_PROFILE"
echo "  WINDOWS_BUILD_TARGET=$WINDOWS_BUILD_TARGET"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  exit 0
fi

EXECUTOR_DIR="$PROJECT_DIR/executor"
EXECUTOR_BINARY_NAME="wegent-executor.exe"
SIDE_CAR_NAME="wegent-executor-${WINDOWS_BUILD_TARGET}.exe"
SIDE_CAR_DIR="$WEWORK_DIR/src-tauri/binaries"

CARGO_PROFILE_ARGS=()
if [ "$BUILD_PROFILE" = "release" ]; then
  CARGO_PROFILE_ARGS=(--release)
fi

cd "$EXECUTOR_DIR"
RUSTFLAGS="-C target-feature=+crt-static" cargo xwin build "${CARGO_PROFILE_ARGS[@]}" --locked --target "$WINDOWS_BUILD_TARGET"

mkdir -p "$SIDE_CAR_DIR"
cp "$EXECUTOR_DIR/target/$WINDOWS_BUILD_TARGET/$BUILD_PROFILE/$EXECUTOR_BINARY_NAME" "$SIDE_CAR_DIR/$SIDE_CAR_NAME"

echo "Sidecar ready: $SIDE_CAR_DIR/$SIDE_CAR_NAME"
