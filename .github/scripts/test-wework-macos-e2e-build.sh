#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

artifact_dir="$temp_dir/artifacts"
app_bundle="$temp_dir/WeWork.app"
backend_rs="$temp_dir/wegent-backend-rs"
mkdir -p \
  "$app_bundle/Contents/MacOS" \
  "$app_bundle/Contents/Resources/bin" \
  "$app_bundle/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin"
printf 'app\n' >"$app_bundle/Contents/MacOS/WeWork"
printf 'executor\n' >"$app_bundle/Contents/Resources/bin/wegent-executor"
printf 'codex\n' \
  >"$app_bundle/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin/codex"
printf 'backend\n' >"$backend_rs"
chmod 0755 \
  "$app_bundle/Contents/MacOS/WeWork" \
  "$app_bundle/Contents/Resources/bin/wegent-executor" \
  "$app_bundle/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin/codex" \
  "$backend_rs"

WEWORK_E2E_ELECTRON_PACKAGE_DIR="$app_bundle" \
WEWORK_E2E_BACKEND_RS_BUILD_BIN="$backend_rs" \
  "$script_dir/archive-wework-macos-e2e-build.sh" "$artifact_dir"
test -s "$artifact_dir/wework-macos-e2e-build.tar.zst"
"$script_dir/restore-wework-macos-e2e-build.sh" "$artifact_dir"
cmp \
  "$app_bundle/Contents/MacOS/WeWork" \
  "$artifact_dir/wework-macos-e2e-build/WeWork.app/Contents/MacOS/WeWork"
cmp "$backend_rs" "$artifact_dir/wework-macos-e2e-build/wegent-backend-rs"

repo="$temp_dir/repo"
mkdir -p \
  "$repo/.github/scripts" \
  "$repo/packages/chat-core" \
  "$repo/wework/e2e" \
  "$repo/wework/src"
cp \
  "$script_dir/archive-wework-macos-e2e-build.sh" \
  "$script_dir/build-macos-e2e-runtimes.sh" \
  "$script_dir/resolve-wework-macos-e2e-build-ref.sh" \
  "$repo/.github/scripts/"
printf 'source\n' >"$repo/wework/src/app.ts"
printf 'scenario\n' >"$repo/wework/e2e/scenario.mjs"
printf '{}\n' >"$repo/package.json"
printf 'lock\n' >"$repo/pnpm-lock.yaml"
printf 'packages:\n' >"$repo/pnpm-workspace.yaml"
(
  cd "$repo"
  git init -q
  git add .
)

resolve_reference() {
  (
    cd "$repo"
    GITHUB_OUTPUT="$temp_dir/output" \
      .github/scripts/resolve-wework-macos-e2e-build-ref.sh \
      wecode-ai \
      executor-source \
      backend-source
  )
  sed -n 's/^reference=//p' "$temp_dir/output" | tail -1
}

reference_before="$(resolve_reference)"
printf 'changed scenario\n' >"$repo/wework/e2e/scenario.mjs"
(cd "$repo" && git add wework/e2e/scenario.mjs)
reference_after_e2e="$(resolve_reference)"
test "$reference_before" = "$reference_after_e2e"

printf 'changed source\n' >"$repo/wework/src/app.ts"
(cd "$repo" && git add wework/src/app.ts)
reference_after_source="$(resolve_reference)"
test "$reference_before" != "$reference_after_source"

/bin/bash "$repo/.github/scripts/resolve-wework-macos-e2e-build-ref.sh" \
  WECODE-AI \
  executor-source \
  backend-source |
  grep -Fq 'ghcr.io/wecode-ai/wegent-wework-macos-e2e-build:v1-'

echo "Wework macOS E2E build tests passed"
