#!/usr/bin/env bash

set -euo pipefail

artifact_dir="${1:-.ci-artifacts}"
archive="$artifact_dir/wework-core-e2e-build.tar.zst"
staging_dir="$artifact_dir/wework-core-e2e-build"
codex_target="x86_64-unknown-linux-gnu"
electron_package="${WEWORK_E2E_ELECTRON_PACKAGE_DIR:-wework/electron/release/WeWork-linux-x64}"
app_binary="$electron_package/WeWork"
executor_binary="$electron_package/resources/bin/wegent-executor"
backend_rs_binary="${WEWORK_E2E_BACKEND_RS_BUILD_BIN:-.ci-artifacts/wegent-backend-rs}"
component_manifest="$electron_package/resources/components.json"
core_plugins="$electron_package/resources/wework-core-plugins"
core_dsh="$electron_package/resources/harness-runtime"
packaged_codex="$electron_package/resources/codex"
codex_root="wework/resources/binaries/codex/$codex_target"

test -d "$electron_package"
test -x "$app_binary"
test -x "$executor_binary"
test -x "$backend_rs_binary"
test -f "$component_manifest"
test -d "$core_plugins"
test -d "$core_dsh"
test -d "$packaged_codex"
test -d "$codex_root"
test ! -L "$codex_root"

rm -rf "$staging_dir"
mkdir -p "$staging_dir/codex"
cp -a "$electron_package" "$staging_dir/electron-app"
runtime_asset_cache="$(node --input-type=module -e "import { resolveSharedHarnessRuntimeAssetCacheRoot } from './wework/scripts/lib/harness-runtime-cache.mjs'; console.log(resolveSharedHarnessRuntimeAssetCacheRoot() + '/harness-runtime-assets')")"
node wework/scripts/collect-harness-runtime-release-assets.mjs \
  "$runtime_asset_cache" \
  "$staging_dir/electron-app/resources/e2e-runtime-assets" \
  "$core_dsh/runtimes.json"
cp -R "$codex_root" "$staging_dir/codex/$codex_target"
mkdir -p "$staging_dir/backend-rs"
cp "$backend_rs_binary" "$staging_dir/backend-rs/wegent-backend-rs"
node wework/scripts/build-desktop-e2e-client.mjs "$staging_dir/e2e-client"
chmod 0755 \
  "$staging_dir/electron-app/WeWork" \
  "$staging_dir/electron-app/resources/bin/wegent-executor" \
  "$staging_dir/backend-rs/wegent-backend-rs"

if [[ "$(uname -s)" == "Linux" ]]; then
  strip --strip-debug \
    "$staging_dir/electron-app/WeWork" \
    "$staging_dir/backend-rs/wegent-backend-rs"
fi

# Executor bytes must remain identical to the packaged schema proof.
node --input-type=module - "$staging_dir/electron-app/resources" <<'NODE'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashComponentPath } from './wework/scripts/lib/component-content-hash.mjs'

const resources = process.argv[2]
const { executor } = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8')).components
assert.equal(await hashComponentPath(join(resources, executor.path)), executor.sha256,
  'E2E archive Executor must match its packaged schema proof')
NODE

tar -I 'zstd -T0 -3' -cf "$archive" -C "$artifact_dir" wework-core-e2e-build
test -s "$archive"
