#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
EXECUTOR_DIR="$PROJECT_DIR/executor"

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"

if [ "${WEGENT_CARGO_TARGET_DIR_AUTO:-0}" = "1" ]; then
  unset CARGO_TARGET_DIR
  unset WEGENT_CARGO_TARGET_DIR_AUTO
fi

configure_executor_dev_target_dir() {
  if [ "${WEGENT_DISABLE_SHARED_CARGO_TARGET:-0}" = "1" ] || [ -n "${CARGO_TARGET_DIR:-}" ]; then
    configure_wegent_cargo_target_dir "$PROJECT_DIR" "executor"
    return 0
  fi

  local cache_root
  cache_root="$(wegent_cargo_cache_root)"
  if [ -z "$cache_root" ]; then
    configure_wegent_cargo_target_dir "$PROJECT_DIR" "executor"
    return 0
  fi

  export CARGO_TARGET_DIR="$cache_root/executor-dev"
  export WEGENT_CARGO_TARGET_DIR_AUTO=1
  mkdir -p "$CARGO_TARGET_DIR"
  configure_wegent_sccache "$PROJECT_DIR" "$CARGO_TARGET_DIR"
}

configure_executor_dev_target_dir
export WEGENT_EXECUTOR_SOURCE_DIR="$EXECUTOR_DIR"

if [ "${WEGENT_EXECUTOR_DEV_RELOAD:-1}" != "0" ] && [ -z "${WEGENT_EXECUTOR_BINARY:-}" ]; then
  cargo build \
    --manifest-path "$EXECUTOR_DIR/Cargo.toml" \
    --features dev-reload \
    --bin wegent-executor-dev
  exec "$(cargo_target_binary_path "$EXECUTOR_DIR" debug wegent-executor-dev)" "$@"
fi

if [ -n "${WEGENT_EXECUTOR_BINARY:-}" ]; then
  exec "$WEGENT_EXECUTOR_BINARY" "$@"
fi

if [ -x "$EXECUTOR_DIR/dist/wegent-executor" ]; then
  exec "$EXECUTOR_DIR/dist/wegent-executor" "$@"
fi

if [ "${WEGENT_CARGO_TARGET_DIR_AUTO:-0}" != "1" ] \
  && [ -x "$(cargo_target_binary_path "$EXECUTOR_DIR" release wegent-executor)" ]; then
  exec "$(cargo_target_binary_path "$EXECUTOR_DIR" release wegent-executor)" "$@"
fi

cargo build --manifest-path "$EXECUTOR_DIR/Cargo.toml" --bin wegent-executor
exec "$(cargo_target_binary_path "$EXECUTOR_DIR" debug wegent-executor)" "$@"
