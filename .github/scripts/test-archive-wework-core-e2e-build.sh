#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
export ARCHIVE_TEST_NODE="$(command -v node)"
export ARCHIVE_TEST_ROOT="$temp_dir"

package="$temp_dir/package"
mkdir -p "$temp_dir/bin" "$temp_dir/repo/wework/scripts/lib" \
  "$temp_dir/repo/wework/resources/binaries/codex/x86_64-unknown-linux-gnu" \
  "$package/resources/bin" "$package/resources/wework-core-plugins" \
  "$package/resources/harness-runtime" "$package/resources/codex"
cp "$repo_root/wework/scripts/lib/component-content-hash.mjs" \
  "$temp_dir/repo/wework/scripts/lib/"
printf 'app bytes\n' >"$package/WeWork"
printf 'executor bytes\n' >"$package/resources/bin/wegent-executor"
printf 'backend bytes\n' >"$temp_dir/backend"
chmod 0755 "$package/WeWork" "$package/resources/bin/wegent-executor" "$temp_dir/backend"
"$ARCHIVE_TEST_NODE" --input-type=module - "$package/resources" <<'NODE'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const resources = process.argv[2]
const path = 'bin/wegent-executor'
const sha256 = createHash('sha256').update(await readFile(join(resources, path))).digest('hex')
await writeFile(join(resources, 'components.json'), JSON.stringify({ components: {
  executor: { path, sha256, workbenchSchema: { protocol_version: 1 } },
} }))
NODE

# Isolate unrelated asset preparation; execute the real copy and hash verification.
cat >"$temp_dir/bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *resolveSharedHarnessRuntimeAssetCacheRoot*) printf '%s\n' "$ARCHIVE_TEST_ROOT/cache" ;;
  *collect-harness-runtime-release-assets.mjs*|*build-desktop-e2e-client.mjs*) ;;
  *) exec "$ARCHIVE_TEST_NODE" "$@" ;;
esac
SH
cat >"$temp_dir/bin/uname" <<'SH'
#!/usr/bin/env bash
printf 'Linux\n'
SH
cat >"$temp_dir/bin/strip" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
shift
for binary in "$@"; do printf 'stripped\n' >>"$binary"; done
SH
cat >"$temp_dir/bin/tar" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  if [[ "$1" == '-cf' ]]; then printf 'archive\n' >"$2"; exit 0; fi
  shift
done
exit 1
SH
chmod 0755 "$temp_dir/bin/"*
export PATH="$temp_dir/bin:$PATH"
export WEWORK_E2E_ELECTRON_PACKAGE_DIR="$package"
export WEWORK_E2E_BACKEND_RS_BUILD_BIN="$temp_dir/backend"

(cd "$temp_dir/repo" && bash "$script_dir/archive-wework-core-e2e-build.sh" artifacts)
cmp "$package/resources/bin/wegent-executor" \
  "$temp_dir/repo/artifacts/wework-core-e2e-build/electron-app/resources/bin/wegent-executor"
grep -q 'stripped' "$temp_dir/repo/artifacts/wework-core-e2e-build/electron-app/WeWork"

# Corrupted packaged bytes must stop the build before a shared archive is published.
printf 'changed\n' >>"$package/resources/bin/wegent-executor"
if (cd "$temp_dir/repo" && bash "$script_dir/archive-wework-core-e2e-build.sh" invalid-artifacts) \
  >"$temp_dir/rejected.log" 2>&1; then
  echo 'Corrupted Executor unexpectedly archived' >&2
  exit 1
fi
grep -q 'E2E archive Executor must match its packaged schema proof' "$temp_dir/rejected.log"
test ! -e "$temp_dir/repo/invalid-artifacts/wework-core-e2e-build.tar.zst"
echo 'Wework Core E2E archive identity tests passed'
