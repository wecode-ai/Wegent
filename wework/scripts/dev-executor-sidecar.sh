#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
EXECUTOR_DIR="$PROJECT_DIR/executor"

if [ "${WEGENT_EXECUTOR_DEV_RELOAD:-1}" != "0" ] && [ -z "${WEGENT_EXECUTOR_BINARY:-}" ]; then
  exec cargo run \
    --manifest-path "$EXECUTOR_DIR/Cargo.toml" \
    --features dev-reload \
    --bin wegent-executor-dev \
    -- "$@"
fi

if [ -n "${WEGENT_EXECUTOR_BINARY:-}" ]; then
  exec "$WEGENT_EXECUTOR_BINARY" "$@"
fi

if [ -x "$EXECUTOR_DIR/dist/wegent-executor" ]; then
  exec "$EXECUTOR_DIR/dist/wegent-executor" "$@"
fi

if [ -x "$EXECUTOR_DIR/target/release/wegent-executor" ]; then
  exec "$EXECUTOR_DIR/target/release/wegent-executor" "$@"
fi

exec cargo run --manifest-path "$EXECUTOR_DIR/Cargo.toml" --bin wegent-executor -- "$@"
