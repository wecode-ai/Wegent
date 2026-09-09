#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mobile_dir="$(cd -- "$script_dir/.." && pwd)"

usage() {
  printf 'Usage: %s [ios|android] [Expo arguments...]\n' "$(basename -- "$0")"
  printf '\n'
  printf 'Without a platform argument, the script opens an interactive selector.\n'
}

select_platform() {
  printf 'Select a platform:\n' >&2
  printf '  1) iOS\n' >&2
  printf '  2) Android\n' >&2
  printf '> ' >&2
  read -r selection

  case "$selection" in
    1 | ios | iOS) printf 'ios\n' ;;
    2 | android | Android) printf 'android\n' ;;
    *)
      printf 'Invalid platform selection: %s\n' "$selection" >&2
      exit 2
      ;;
  esac
}

platform="${1:-}"
if [[ -z "$platform" ]]; then
  platform="$(select_platform)"
else
  shift
fi

case "$platform" in
  ios | android) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is required but was not found in PATH.\n' >&2
  exit 1
fi

if [[ ! -x "$mobile_dir/node_modules/.bin/expo" ]]; then
  printf 'Installing Wework Mobile dependencies...\n'
  pnpm --dir "$mobile_dir" install
fi

if [[ "$platform" == 'ios' ]]; then
  if [[ "$(uname -s)" != 'Darwin' ]] || ! command -v xcrun >/dev/null 2>&1; then
    printf 'iOS requires macOS with Xcode command-line tools.\n' >&2
    exit 1
  fi
fi

printf 'Starting Wework Mobile on %s...\n' "$platform"
cd -- "$mobile_dir"
if (( $# > 0 )); then
  pnpm run "$platform" -- "$@"
else
  pnpm run "$platform"
fi
