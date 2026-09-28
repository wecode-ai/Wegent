#!/usr/bin/env bash

set -euo pipefail

if (($# != 2)); then
  echo "usage: $0 <executor-destination> <backend-rs-destination>" >&2
  exit 2
fi

executor_destination="$1"
backend_destination="$2"
executor_target_dir="${WEWORK_EXECUTOR_TARGET_DIR:-$PWD/executor/target}"
backend_target_dir="${WEWORK_BACKEND_RS_TARGET_DIR:-$PWD/backend-rs/target}"

install_runtime() {
  local source="$1"
  local destination="$2"
  local temporary="${destination}.build.$$"

  mkdir -p "$(dirname "$destination")"
  cp "$source" "$temporary"
  chmod 0755 "$temporary"
  mv -f "$temporary" "$destination"
}

executor_pid=""
if [[ ! -x "$executor_destination" ]]; then
  (
    CARGO_TARGET_DIR="$executor_target_dir" cargo build \
      --release \
      --locked \
      --target aarch64-apple-darwin \
      --manifest-path executor/Cargo.toml \
      --bin wegent-executor
    install_runtime \
      "$executor_target_dir/aarch64-apple-darwin/release/wegent-executor" \
      "$executor_destination"
  ) &
  executor_pid=$!
fi

backend_pid=""
if [[ ! -x "$backend_destination" ]]; then
  (
    CARGO_TARGET_DIR="$backend_target_dir" cargo build \
      --locked \
      --manifest-path backend-rs/Cargo.toml \
      --bin wegent-backend-rs
    install_runtime \
      "$backend_target_dir/debug/wegent-backend-rs" \
      "$backend_destination"
  ) &
  backend_pid=$!
fi

status=0
if [[ -n "$executor_pid" ]] && ! wait "$executor_pid"; then
  status=1
fi
if [[ -n "$backend_pid" ]] && ! wait "$backend_pid"; then
  status=1
fi
if ((status != 0)); then
  exit "$status"
fi

test -x "$executor_destination"
test -x "$backend_destination"
