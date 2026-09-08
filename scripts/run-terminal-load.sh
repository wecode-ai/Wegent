#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-baseline}"

case "$profile" in
  quick)
    backend_args=(--instances 3 --sessions 100 --rounds 5 --revocations 10 --concurrency 16)
    executor_args=(--sessions 4 --bytes-per-session 1048576 --chunk-bytes 8192 --ack-delay-ms 50)
    ;;
  baseline)
    backend_args=(--instances 3 --sessions 1000 --rounds 20 --revocations 100 --concurrency 64)
    executor_args=(--sessions 32 --bytes-per-session 1048576 --chunk-bytes 8192 --ack-delay-ms 50)
    ;;
  capacity)
    backend_args=(--instances 1 --sessions 8192 --rounds 5 --revocations 200 --concurrency 128)
    executor_args=(--sessions 100 --bytes-per-session 1048576 --chunk-bytes 8192 --ack-delay-ms 200)
    ;;
  over-capacity)
    backend_args=(--instances 1 --sessions 9000 --rounds 2 --revocations 200 --concurrency 128)
    executor_args=(--sessions 100 --bytes-per-session 1048576 --chunk-bytes 8192 --ack-delay-ms 200)
    ;;
  *)
    echo "usage: $0 [quick|baseline|capacity|over-capacity]" >&2
    exit 2
    ;;
esac

if [[ -n "${TERMINAL_LOAD_REDIS_URL:-}" ]]; then
  backend_args+=(--redis-url "$TERMINAL_LOAD_REDIS_URL")
fi

echo "backend:"
(
  cd "$repo_root/backend"
  uv run python -m scripts.terminal_session_cache_load "${backend_args[@]}"
)

echo "executor:"
(
  cd "$repo_root/executor"
  cargo run --quiet --example terminal_load -- "${executor_args[@]}"
)
