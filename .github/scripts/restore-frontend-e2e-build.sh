#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/frontend-next-build.tar.zst"

find_standalone_server() {
  local candidate
  for candidate in \
    frontend/.next/standalone/server.js \
    frontend/.next/standalone/frontend/server.js; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  find frontend/.next/standalone \
    -maxdepth 3 \
    -type f \
    -name server.js \
    ! -path '*/node_modules/*' \
    | sort \
    | head -n 1
}

test -s "$archive"

rm -rf frontend/.next
tar -I zstd -xf "$archive" -C frontend

test -f frontend/.next/BUILD_ID
standalone_server="$(find_standalone_server)"
test -n "$standalone_server"
test -f "$standalone_server"
test -d "$(dirname "$standalone_server")/public"
test -d "$(dirname "$standalone_server")/.next/static"
