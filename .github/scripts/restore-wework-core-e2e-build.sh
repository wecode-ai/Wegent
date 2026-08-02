#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/wework-core-e2e-build.tar.zst"
build_dir="$artifact_dir/wework-core-e2e-build"
codex_binary="$build_dir/codex/x86_64-unknown-linux-gnu/vendor/x86_64-unknown-linux-musl/bin/codex"

test -s "$archive"

rm -rf "$build_dir"
tar -I zstd -xf "$archive" -C "$artifact_dir"
chmod 0755 "$build_dir/WeWork" "$build_dir/wegent-executor" "$codex_binary"

test -x "$build_dir/WeWork"
test -x "$build_dir/wegent-executor"
test -x "$codex_binary"
