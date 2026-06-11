#!/usr/bin/env bash
#
# Run the WeWork iOS app in dev mode (simulator or physical device) against a
# chosen environment's backend.
#
# Usage:
#   bash scripts/dev-ios-app.sh [--env ENV] [--device NAME] [--open] [--verbose]
#
# Options:
#   --env ENV       Environment name -> scripts/ios-env/<ENV>.env (default: dev)
#   --device NAME    Run on the named device/simulator (default: auto-select).
#   --open           Open the Xcode project instead of running.
#   --verbose        Verbose tauri logging.
#
# Examples:
#   bash scripts/dev-ios-app.sh
#   bash scripts/dev-ios-app.sh --env staging
#   bash scripts/dev-ios-app.sh --device "iPhone 16 Pro"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/wework-ios-env.sh
source "$SCRIPT_DIR/lib/wework-ios-env.sh"

ENV_NAME="dev"
DEVICE=""
OPEN_XCODE=0
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    --device) DEVICE="$2"; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; shift ;;
    --open) OPEN_XCODE=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

load_wework_env "$ENV_NAME"

echo "Starting WeWork iOS dev"
print_wework_env_summary "$ENV_NAME"
[ -n "$DEVICE" ] && echo "  DEVICE=$DEVICE"

DEV_ARGS=(ios dev)
[ -n "$DEVICE" ] && DEV_ARGS+=("$DEVICE")
[ "$OPEN_XCODE" = "1" ] && DEV_ARGS+=(--open)
[ "$VERBOSE" = "1" ] && DEV_ARGS+=(--verbose)

if [ "${WEWORK_DRY_RUN:-}" = "1" ]; then
  echo "  DRY RUN: npx tauri ${DEV_ARGS[*]}"
  exit 0
fi

cd "$WEWORK_DIR"
exec npx tauri "${DEV_ARGS[@]}"
