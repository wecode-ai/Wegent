#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/wework-macos-e2e-build.tar.zst"
staging_dir="$artifact_dir/wework-macos-e2e-build"

test -s "$archive"
rm -rf "$staging_dir"
zstd -d -c "$archive" | tar -xf - -C "$artifact_dir"
test -x "$staging_dir/WeWork.app/Contents/MacOS/WeWork"
test -x "$staging_dir/WeWork.app/Contents/Resources/bin/wegent-executor"
test -x \
  "$staging_dir/WeWork.app/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin/codex"
test -x "$staging_dir/wegent-backend-rs"
