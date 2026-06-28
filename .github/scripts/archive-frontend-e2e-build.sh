#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/frontend-next-build.tar.zst"

mkdir -p "$artifact_dir"

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

test -f frontend/.next/BUILD_ID
test -d frontend/.next/static
test -d frontend/public

standalone_server="$(find_standalone_server)"
test -n "$standalone_server"
test -f "$standalone_server"

standalone_dir="$(dirname "$standalone_server")"
rm -rf "$standalone_dir/public" "$standalone_dir/.next/static"
mkdir -p "$standalone_dir/.next"
cp -R frontend/public "$standalone_dir/public"
cp -R frontend/.next/static "$standalone_dir/.next/static"

tar --exclude='.next/cache' -I 'zstd -T0 -3' -cf "$archive" -C frontend .next public
test -s "$archive"
