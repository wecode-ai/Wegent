#!/usr/bin/env bash
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stage="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/native-event-goal.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# Reuse the managed binary downloader and its checked-in integrity lock.
# Only its packaging and download dependencies are needed; do not install the
# Wework workspace.
mkdir -p "$stage/wework/scripts/lib" "$stage/wework/third_party/codex" "$stage/LICENSES"
cp "$repository/wework/scripts/prepare-codex-binary.mjs" "$stage/wework/scripts/"
cp "$repository/wework/scripts/lib/process-lock.mjs" "$stage/wework/scripts/lib/"
cp "$repository/wework/scripts/lib/windows-native-runtime.mjs" "$stage/wework/scripts/lib/"
cp "$repository/wework/codex-binaries.lock.json" "$stage/wework/"
cp "$repository/LICENSES/Apache-2.0.txt" "$stage/LICENSES/"
cp "$repository/wework/third_party/codex/NOTICE" "$repository/wework/third_party/codex/RATATUI-LICENSE.txt" "$stage/wework/third_party/codex/"
npm install --prefix "$stage/wework" --no-save --package-lock=false --ignore-scripts tar@7.5.20 undici@7.27.2
WEGENT_CODEX_CACHE_DIR="$stage/cache" node "$stage/wework/scripts/prepare-codex-binary.mjs" --materialize
native_goal_binary="$(node --input-type=module - "$stage/wework/resources/binaries/codex" <<'NODE'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.argv[2]
const binaries = []
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const target = join(root, entry.name)
  try {
    const metadata = JSON.parse(await readFile(join(target, 'WEGENT_CODEX_BINARY.json'), 'utf8'))
    binaries.push(join(target, metadata.binaryPath))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
if (binaries.length !== 1) throw new Error('Expected one prepared native Codex target')
console.log(binaries[0])
NODE
)"
cd "$repository/executor"
WEWORK_GOAL_TEST_CODEX_BINARY="$native_goal_binary" cargo test -p wegent-executor --all-features --lib native_event_goal -- --ignored --nocapture

# The persistent device image currently pins its own CLI version. Verify that
# delivered version too, until both delivery channels use the same pin.
device_codex_version="$(node --input-type=module - "$repository/docker/device/Dockerfile" <<'NODE'
import { readFile } from 'node:fs/promises'
const source = await readFile(process.argv[2], 'utf8')
const versions = [...new Set([...source.matchAll(/@openai\/codex@([0-9]+\.[0-9]+\.[0-9]+)/g)].map(match => match[1]))]
if (versions.length !== 1) throw new Error('Expected one pinned device Codex version')
console.log(versions[0])
NODE
)"
managed_codex_version="$(node -p 'require(process.argv[1]).codexVersion' "$repository/wework/codex-binaries.lock.json")"
if [ "$device_codex_version" != "$managed_codex_version" ]; then
    npm install --prefix "$stage/device" --no-save --package-lock=false --ignore-scripts "@openai/codex@$device_codex_version"
    device_native_binary="$(find "$stage/device/node_modules" -type f \( -path '*/bin/codex' -o -path '*/bin/codex.exe' \))"
    test -f "$device_native_binary"
    WEWORK_GOAL_TEST_CODEX_BINARY="$device_native_binary" cargo test -p wegent-executor --all-features --lib native_event_goal -- --ignored --nocapture
fi
