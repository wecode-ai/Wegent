#!/usr/bin/env bash

set -euo pipefail
trap 'printf "macOS E2E build contract failed at line %s\n" "$LINENO" >&2' ERR

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ruby -ryaml - "$script_dir/../workflows" <<'RUBY'
workflow_dir = ARGV.fetch(0)
{
  'wework-e2e.yml' => 'wework-desktop-memory-e2e',
  'ci-cache-warmup.yml' => 'warm-wework-macos-electron'
}.each do |workflow, job|
  resolver_id = 'macos-source'
  steps = YAML.load_file(File.join(workflow_dir, workflow)).fetch('jobs').fetch(job).fetch('steps')
  resolver_index = steps.index { |step| step['id'] == resolver_id }
  abort "#{workflow}: missing early source digest resolver" unless resolver_index
  resolver = steps.fetch(resolver_index)
  {'executor' => 'executor_digest', 'backend-rs' => 'backend_digest'}.each do |component, variable|
    command = "$(node .github/scripts/macos-e2e-source-digest.mjs #{component})"
    abort "#{workflow}: source hashing must use the tracked-input helper" unless resolver.fetch('run').include?(%Q{#{variable}="#{command}"})
    abort "#{workflow}: source digest is not exported" unless resolver.fetch('run').include?(%Q{echo "#{component}=$#{variable}" >> "$GITHUB_OUTPUT"})
  end
  steps.each_with_index do |step, index|
    if index < resolver_index && (step['uses'] || '').include?('cache')
      abort "#{workflow}: source hashing must precede dependency restoration"
    end
    abort "#{workflow}: workspace source globbing can time out" if step.to_s.match?(/hashFiles\([^)]*src\/\*\*/)
  end
  {
    'executor' => 'executor',
    'Rust backend' => 'backend-rs'
  }.each do |runtime, output|
    step = steps.find { |item| item['name'] == "Restore macOS arm64 #{runtime} runtime" }
    reference = "${{ steps.#{resolver_id}.outputs.#{output} }}"
    abort "#{workflow}: runtime cache must reuse the source digest" unless step.fetch('with').fetch('key').end_with?(reference)
    oci_steps = steps.select { |item| item['name'].match?(/macOS arm64 runtimes (from|to) OCI/) }
    variable = runtime == 'executor' ? 'EXECUTOR_SOURCE_REF' : 'BACKEND_SOURCE_REF'
    abort "#{workflow}: OCI runtimes must reuse the cache source digest" unless oci_steps.all? { |item| item.fetch('env').fetch(variable).end_with?(reference) }
  end
  build = steps.find { |item| item['name'].match?(/(Resolve|Publish) shared macOS Wework E2E build/) }
  {'EXECUTOR_SOURCE_DIGEST' => 'executor', 'BACKEND_RS_SOURCE_DIGEST' => 'backend-rs'}.each do |variable, output|
    reference = "${{ steps.#{resolver_id}.outputs.#{output} }}"
    abort "#{workflow}: shared build must reuse the runtime source digest" unless build.fetch('env').fetch(variable) == reference
  end
end
RUBY

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
  "$repo/packages/collaboration" \
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

printf 'shared issue UI\n' >"$repo/packages/collaboration/issue.ts"
(cd "$repo" && git add packages/collaboration/issue.ts)
reference_after_collaboration="$(resolve_reference)"
test "$reference_after_source" != "$reference_after_collaboration"

printf 'changed shared issue UI\n' >"$repo/packages/collaboration/issue.ts"
(cd "$repo" && git add packages/collaboration/issue.ts)
test "$reference_after_collaboration" != "$(resolve_reference)"

(
  cd "$repo"
  GITHUB_OUTPUT=/dev/stdout \
    /bin/bash .github/scripts/resolve-wework-macos-e2e-build-ref.sh \
    WECODE-AI \
    executor-source \
    backend-source
) | grep -Fq 'ghcr.io/wecode-ai/wegent-wework-macos-e2e-build:v1-'

echo "Wework macOS E2E build tests passed"
