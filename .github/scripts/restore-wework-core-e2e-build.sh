#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/wework-core-e2e-build.tar.zst"
build_dir="$artifact_dir/wework-core-e2e-build"
app_binary="$build_dir/electron-app/WeWork"
executor_binary="$build_dir/electron-app/resources/bin/wegent-executor"
codex_binary="$build_dir/codex/x86_64-unknown-linux-gnu/vendor/x86_64-unknown-linux-musl/bin/codex"
backend_rs_binary="$build_dir/backend-rs/wegent-backend-rs"

test -s "$archive"
echo "[wework-core-e2e-build] downloaded bytes=$(wc -c < "$archive")"
sha256sum "$archive"

rm -rf "$build_dir"
restore_status=0
tar -I zstd -xf "$archive" -C "$artifact_dir" || restore_status=$?
if ((restore_status != 0)); then
  # Diagnostic failures must not replace the extraction exit code.
  set +e
  echo "[wework-core-e2e-build] restore failed: exit=$restore_status" >&2
  echo "[wework-core-e2e-build] after failure bytes=$(wc -c < "$archive")" >&2
  sha256sum "$archive" >&2
  zstd --version >&2
  df -h "$artifact_dir" >&2
  if zstd -t "$archive"; then
    echo "[wework-core-e2e-build] compressed stream is intact" >&2
  else
    echo "[wework-core-e2e-build] compressed stream validation failed" >&2
  fi
  exit "$restore_status"
fi
chmod 0755 "$app_binary" "$executor_binary" "$codex_binary" "$backend_rs_binary"

test -x "$app_binary"
test -x "$executor_binary"
test -x "$codex_binary"
test -x "$backend_rs_binary"
test -s "$build_dir/e2e-client/socket.io-client.cjs"
