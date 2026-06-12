#!/usr/bin/env bash
#
# Build (package) the WeWork iOS app for a given environment.
#
# Usage:
#   bash scripts/build-ios-app.sh [--env ENV] [--target TARGET] \
#        [--export-method METHOD] [--build-number N] [--open] \
#        [--archive-only] [--no-sign] [--verbose]
#
# Options:
#   --env ENV               Environment name -> scripts/ios-env/<ENV>.env (default: prod)
#   --target TARGET         device | sim | x86_64  (default: device)
#                             device -> aarch64       (real iPhone/iPad, produces IPA)
#                             sim    -> aarch64-sim   (Apple Silicon simulator)
#                             x86_64 -> x86_64        (Intel simulator)
#   --export-method METHOD  app-store-connect | release-testing | debugging
#                             (default: release-testing; used for device IPA export)
#   --build-number N        Append a build number to the app version.
#   --open                  Open the generated Xcode project after building.
#   --archive-only          Only archive, skip IPA generation.
#   --no-sign               Skip code signing.
#   --verbose               Verbose tauri logging.
#
# Examples:
#   bash scripts/build-ios-app.sh --env prod
#   bash scripts/build-ios-app.sh --env staging --target sim
#   bash scripts/build-ios-app.sh --env prod --export-method app-store-connect

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/wework-ios-env.sh
source "$SCRIPT_DIR/lib/wework-ios-env.sh"

ENV_NAME="prod"
TARGET="device"
EXPORT_METHOD="release-testing"
BUILD_NUMBER=""
OPEN_XCODE=0
ARCHIVE_ONLY=0
NO_SIGN=0
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --export-method) EXPORT_METHOD="$2"; shift 2 ;;
    --export-method=*) EXPORT_METHOD="${1#*=}"; shift ;;
    --build-number) BUILD_NUMBER="$2"; shift 2 ;;
    --build-number=*) BUILD_NUMBER="${1#*=}"; shift ;;
    --open) OPEN_XCODE=1; shift ;;
    --archive-only) ARCHIVE_ONLY=1; shift ;;
    --no-sign) NO_SIGN=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Map friendly target names to tauri target triples.
case "$TARGET" in
  device) TAURI_TARGET="aarch64" ;;
  sim) TAURI_TARGET="aarch64-sim" ;;
  x86_64) TAURI_TARGET="x86_64" ;;
  *) echo "error: invalid --target '$TARGET' (device|sim|x86_64)" >&2; exit 1 ;;
esac

load_wework_env "$ENV_NAME"

echo "Building WeWork iOS app"
print_wework_env_summary "$ENV_NAME"
echo "  TARGET=$TARGET ($TAURI_TARGET)"
echo "  EXPORT_METHOD=$EXPORT_METHOD"

# Assemble tauri ios build arguments.
BUILD_ARGS=(ios build --target "$TAURI_TARGET" --ci)
BUILD_ARGS+=(--export-method "$EXPORT_METHOD")
[ -n "$BUILD_NUMBER" ] && BUILD_ARGS+=(--build-number "$BUILD_NUMBER")
[ "$OPEN_XCODE" = "1" ] && BUILD_ARGS+=(--open)
[ "$ARCHIVE_ONLY" = "1" ] && BUILD_ARGS+=(--archive-only)
[ "$NO_SIGN" = "1" ] && BUILD_ARGS+=(--no-sign)
[ "$VERBOSE" = "1" ] && BUILD_ARGS+=(--verbose)

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  echo "  DRY RUN: npx tauri ${BUILD_ARGS[*]}"
  exit 0
fi

# Xcode 15+ sandboxes run-script phases, which blocks the "Build Rust Code" phase
# from reading src-tauri (cargo fails: "failed to determine list of files in
# src-tauri" -> "library 'app' not found" at link). xcodegen defaults this to YES
# and it is not configurable via tauri.conf.json, so patch the generated project.
# Idempotent and re-applied here so it survives `tauri ios init` regeneration.
PBXPROJ="$WEWORK_DIR/src-tauri/gen/apple/app.xcodeproj/project.pbxproj"
if [ -f "$PBXPROJ" ]; then
  sed -i '' 's/ENABLE_USER_SCRIPT_SANDBOXING = YES;/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g' "$PBXPROJ"
fi

cd "$WEWORK_DIR"
exec npx tauri "${BUILD_ARGS[@]}"
