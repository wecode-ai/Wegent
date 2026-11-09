#!/usr/bin/env bash
set -euo pipefail

container=$1
log=$2
shift 2
capture_root=$(mktemp -d)
monitor_pid=
filter_pid=
cleanup() {
  [[ -z "$monitor_pid" ]] || kill "$monitor_pid" 2>/dev/null || true
  [[ -z "$monitor_pid" ]] || wait "$monitor_pid" 2>/dev/null || true
  [[ -z "$filter_pid" ]] || wait "$filter_pid" 2>/dev/null || true
  rm -rf "$capture_root"
}
trap cleanup EXIT
mkfifo "$capture_root/monitor"
# Retain only timestamps, connection metadata and command names, never arguments.
docker exec "$container" redis-cli MONITOR > "$capture_root/monitor" &
monitor_pid=$!
awk '{ print $1, $2, $3, $4; fflush() }' < "$capture_root/monitor" > "$log" &
filter_pid=$!

# OK establishes readiness only; actual command capture is checked after the test.
ready_deadline=$((SECONDS + 5))
until awk 'NR == 1 && $1 == "OK" { ready = 1 } END { exit !ready }' "$log"; do
  kill -0 "$monitor_pid"
  kill -0 "$filter_pid"
  if (( SECONDS >= ready_deadline )); then
    echo 'Redis MONITOR did not become ready within 5 seconds' >&2
    exit 1
  fi
  sleep 0.1
done

"$@"
kill -0 "$monitor_pid"
kill -0 "$filter_pid"
kill "$monitor_pid"
wait "$monitor_pid" 2>/dev/null || true
monitor_pid=
wait "$filter_pid"
filter_pid=
awk 'NF >= 4 { captured = 1 } END { exit !captured }' "$log"
