#!/usr/bin/env bash
# Regression test for WeWork macOS dev port selection.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_SCRIPT="$PROJECT_ROOT/wework/scripts/dev-mac-app.sh"

port_is_free() {
  node - "$1" <<'NODE'
const net = require('node:net')
const port = Number(process.argv[2])
const server = net.createServer()

server.once('error', () => process.exit(1))
server.listen(port, '127.0.0.1', () => {
  server.close(() => process.exit(0))
})
NODE
}

find_free_port_pair() {
  local port

  for port in $(seq 41000 65000); do
    if port_is_free "$port" && port_is_free "$((port + 1))"; then
      echo "$port"
      return 0
    fi
  done

  echo "Could not find two adjacent free ports." >&2
  return 1
}

start_port_listener() {
  local port="$1"
  local ready_file="$2"

  node - "$port" "$ready_file" <<'NODE' &
const fs = require('node:fs')
const net = require('node:net')
const port = Number(process.argv[2])
const readyFile = process.argv[3]
const server = net.createServer()

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(readyFile, 'ready')
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
NODE
}

wait_for_listener() {
  local pid="$1"
  local ready_file="$2"

  for _ in $(seq 1 50); do
    if [ -f "$ready_file" ]; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Port listener exited before becoming ready." >&2
      return 1
    fi
    sleep 0.1
  done

  echo "Timed out waiting for port listener." >&2
  return 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    echo "Expected $label to contain: $needle" >&2
    echo "$haystack" >&2
    return 1
  fi
}

requested_port="$(find_free_port_pair)"
expected_port="$((requested_port + 1))"
ready_file="$(mktemp -t wework-port-listener.XXXXXX)"
rm -f "$ready_file"
listener_pid=""

cleanup() {
  rm -f "$ready_file"
  if [ -n "$listener_pid" ] && kill -0 "$listener_pid" 2>/dev/null; then
    kill "$listener_pid"
    wait "$listener_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_port_listener "$requested_port" "$ready_file"
listener_pid="$!"
wait_for_listener "$listener_pid" "$ready_file"

output="$(
  WEGENT_DISABLE_SHARED_CARGO_TARGET=1 \
    WEWORK_DRY_RUN=1 \
    WEWORK_PORT="$requested_port" \
    bash "$DEV_SCRIPT"
)"

assert_contains "$output" "WEWORK_PORT=$expected_port" "dry-run output"
assert_contains "$output" "\"devUrl\": \"http://localhost:$expected_port\"" "Tauri devUrl"
assert_contains "$output" "pnpm exec vite --host 0.0.0.0 --port $expected_port --strictPort" "beforeDevCommand"
assert_contains "$output" "VITE_WEGENT_BACKEND_URL=" "backend URL"

echo "WeWork macOS dev port selection regression test passed"
