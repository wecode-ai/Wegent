#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
manifest="${2:-$artifact_dir/wework-core-e2e-build.json}"
archive="$artifact_dir/wework-core-e2e-build.tar.zst"
staging_dir="$artifact_dir/wework-core-e2e-build"
codex_target="x86_64-unknown-linux-gnu"

test -s "$manifest"

app_binary="$(
  node -e \
    'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).appBinary)' \
    "$manifest"
)"
executor_binary="$(
  node -e \
    'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).executorBinary)' \
    "$manifest"
)"
codex_root="wework/src-tauri/binaries/codex/$codex_target"

test -x "$app_binary"
test -x "$executor_binary"
test -d "$codex_root"
test ! -L "$codex_root"

rm -rf "$staging_dir"
mkdir -p "$staging_dir/codex"
cp "$app_binary" "$staging_dir/WeWork"
cp "$executor_binary" "$staging_dir/wegent-executor"
cp -R "$codex_root" "$staging_dir/codex/$codex_target"
chmod 0755 "$staging_dir/WeWork" "$staging_dir/wegent-executor"

tar -I 'zstd -T0 -3' -cf "$archive" -C "$artifact_dir" wework-core-e2e-build
test -s "$archive"
