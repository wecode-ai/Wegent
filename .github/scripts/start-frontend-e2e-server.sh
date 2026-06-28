#!/usr/bin/env bash
set -euo pipefail

find_standalone_server() {
  local candidate
  for candidate in \
    .next/standalone/server.js \
    .next/standalone/frontend/server.js; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  find .next/standalone \
    -maxdepth 3 \
    -type f \
    -name server.js \
    ! -path '*/node_modules/*' \
    | sort \
    | head -n 1
}

server_path="$(find_standalone_server)"
test -n "$server_path"
test -f "$server_path"

HOSTNAME="${E2E_FRONTEND_HOSTNAME:-0.0.0.0}" PORT="${PORT:-3000}" \
  nohup node "$server_path" > next-dev.log 2>&1 &
echo $! > next-dev.pid
