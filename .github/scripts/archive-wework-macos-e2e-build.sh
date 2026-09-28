#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/wework-macos-e2e-build.tar.zst"
staging_dir="$artifact_dir/wework-macos-e2e-build"
electron_package="${WEWORK_E2E_ELECTRON_PACKAGE_DIR:-wework/electron/release/WeWork-darwin-arm64/WeWork.app}"
backend_rs_binary="${WEWORK_E2E_BACKEND_RS_BUILD_BIN:-$HOME/.cache/wegent/wework-macos-e2e-runtimes/wegent-backend-rs}"
app_binary="$electron_package/Contents/MacOS/WeWork"
executor_binary="$electron_package/Contents/Resources/bin/wegent-executor"
codex_binary="$electron_package/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin/codex"

test -d "$electron_package"
test -x "$app_binary"
test -x "$executor_binary"
test -x "$codex_binary"
test -x "$backend_rs_binary"

rm -rf "$staging_dir"
mkdir -p "$staging_dir"
cp -R "$electron_package" "$staging_dir/WeWork.app"
cp "$backend_rs_binary" "$staging_dir/wegent-backend-rs"
chmod 0755 \
  "$staging_dir/WeWork.app/Contents/MacOS/WeWork" \
  "$staging_dir/WeWork.app/Contents/Resources/bin/wegent-executor" \
  "$staging_dir/WeWork.app/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin/codex" \
  "$staging_dir/wegent-backend-rs"

tar -cf - -C "$artifact_dir" wework-macos-e2e-build | zstd -T0 -3 -o "$archive"
test -s "$archive"
