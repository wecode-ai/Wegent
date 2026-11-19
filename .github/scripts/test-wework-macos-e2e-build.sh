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
  caller = YAML.load_file(File.join(workflow_dir, workflow)).fetch('jobs').fetch(job)
  abort "#{workflow}: macOS runner baselines differ" unless caller.fetch('runs-on') == 'macos-15'
  abort "#{workflow}: missing shared build action" unless caller.fetch('steps').any? { |step| step['uses'] == './.github/actions/build-wework-macos-e2e' }
  steps = YAML.load_file(File.join(workflow_dir, '../actions/build-wework-macos-e2e/action.yml')).fetch('runs').fetch('steps')
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

mkdir -p "$repo/packages/process-explorer" "$repo/patches"
printf 'process explorer\n' >"$repo/packages/process-explorer/index.ts"
(cd "$repo" && git add packages/process-explorer/index.ts)
reference_after_explorer="$(resolve_reference)"
test "$reference_after_collaboration" != "$reference_after_explorer"
printf 'dependency patch\n' >"$repo/patches/runtime.patch"
(cd "$repo" && git add patches/runtime.patch)
test "$reference_after_explorer" != "$(resolve_reference)"

reference_before_template_data="$(resolve_reference)"
mkdir -p "$repo/shared/data"
printf '{"name":"template"}\n' >"$repo/shared/data/collaboration-templates.json"
(cd "$repo" && git add shared/data/collaboration-templates.json)
reference_after_template_data="$(resolve_reference)"
if [[ "$reference_before_template_data" == "$reference_after_template_data" ]]; then
  echo 'Shared template data must invalidate the complete macOS App key' >&2
  exit 1
fi
printf '{"name":"changed template"}\n' >"$repo/shared/data/collaboration-templates.json"
(cd "$repo" && git add shared/data/collaboration-templates.json)
test "$reference_after_template_data" != "$(resolve_reference)"

(
  cd "$repo"
  GITHUB_OUTPUT=/dev/stdout \
    /bin/bash .github/scripts/resolve-wework-macos-e2e-build-ref.sh \
    WECODE-AI \
    executor-source \
    backend-source
) | grep -Fq 'ghcr.io/wecode-ai/wegent-wework-macos-e2e-runtime:app-v1-'

ruby -ryaml - "$script_dir/../actions/build-wework-macos-e2e/action.yml" >"$temp_dir/build.sh" <<'RUBY'
steps = YAML.load_file(ARGV.fetch(0)).fetch('runs').fetch('steps')
build = steps.find { |step| step['name'] == 'Build Wework Electron E2E application' }.fetch('run')
prepare = steps.find { |step| step['name'] == 'Build native runtimes and install dependencies' }.fetch('run')
puts "(set -e\n#{prepare}\n) || exit $?".sub('$HOME/.cache/wegent/wework-macos-e2e-runtimes', '$TEST_RUNTIME_ROOT')
puts build.sub('$HOME/.cache/wegent/wework-macos-e2e-runtimes', '$TEST_RUNTIME_ROOT')
RUBY

mkdir -p "$repo/bin"
cat >"$repo/.github/scripts/build-macos-e2e-runtimes.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo runtimes >> "$BUILD_EVENTS"
if ((FAIL_RUNTIME_BUILD)); then exit "$FAIL_RUNTIME_BUILD"; fi
mkdir -p "$(dirname "$1")"
for destination in "$@"; do
  printf '#!/bin/sh\nexit 0\n' > "$destination"
  chmod +x "$destination"
done
EOF
cat >"$repo/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *install* ]]; then exit "${FAIL_DEPENDENCIES:-0}"; fi
echo package >> "$BUILD_EVENTS"
if [[ "$INCLUDE_BACKEND" == true ]]; then
  test -x "$WEWORK_E2E_PREBUILT_EXECUTOR_PATH"
  test -x "$TEST_RUNTIME_ROOT/wegent-backend-rs"
else
  test -z "${WEWORK_E2E_PREBUILT_EXECUTOR_PATH:-}"
  test ! -e "$TEST_RUNTIME_ROOT/wegent-backend-rs"
fi
app="wework/electron/release/WeWork-darwin-arm64/WeWork.app/Contents"
mkdir -p "$app/MacOS" "$app/Resources/bin"
for binary in "$app/MacOS/WeWork" "$app/Resources/bin/wegent-executor"; do
  printf '#!/bin/sh\nexit 0\n' > "$binary"
  chmod +x "$binary"
done
EOF
chmod +x "$repo/.github/scripts/build-macos-e2e-runtimes.sh" "$repo/bin/pnpm"

verify_build() {
  local include_backend="$1" fail_runtime="$2" fail_install="$3" expected="$4"
  local case_id="$include_backend-$fail_runtime-$fail_install"
  local events="$temp_dir/build-$case_id.events" status=0
  touch "$events"
  (
    cd "$repo"
    PATH="$repo/bin:$PATH" TEST_RUNTIME_ROOT="$temp_dir/runtime-$case_id" \
      BUILD_EVENTS="$events" INCLUDE_BACKEND="$include_backend" \
      FAIL_RUNTIME_BUILD="$fail_runtime" FAIL_DEPENDENCIES="$fail_install" \
      bash -e -o pipefail "$temp_dir/build.sh"
  ) || status=$?
  test "$status" -eq "$((fail_install || fail_runtime))"
  test "$(cat "$events")" = "$expected"
}

verify_build true 0 0 $'runtimes\npackage'
verify_build true 1 0 runtimes
verify_build false 0 0 package
verify_build false 0 1 ''

echo "Wework macOS E2E build tests passed"
