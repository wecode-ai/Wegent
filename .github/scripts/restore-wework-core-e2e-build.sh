#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/wework-core-e2e-build.tar.zst"
build_dir="$artifact_dir/wework-core-e2e-build"
app_binary="$build_dir/electron-app/WeWork"
executor_binary="$build_dir/electron-app/resources/bin/wegent-executor"
codex_binary="$build_dir/codex/x86_64-unknown-linux-gnu/vendor/x86_64-unknown-linux-musl/bin/codex"

test -s "$archive"

rm -rf "$build_dir"
tar -I zstd -xf "$archive" -C "$artifact_dir"
chmod 0755 "$app_binary" "$executor_binary" "$codex_binary"

test -x "$app_binary"
test -x "$executor_binary"
test -x "$codex_binary"
test -s "$build_dir/e2e-client/socket.io-client.cjs"
