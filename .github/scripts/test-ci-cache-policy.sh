#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workflow_dir="$script_dir/../workflows"
action_dir="$script_dir/../actions"

fail() {
  printf 'CI cache policy check failed: %s\n' "$1" >&2
  exit 1
}

validate_yaml_steps() {
  local mode="$1"
  local file="$2"

  ruby "$script_dir/lib/validate-ci-cache-policy.rb" "$mode" "$file"
}

assert_step_policy_rejects() {
  local mode="$1"
  local name="$2"
  local fixture="$3"

  if validate_yaml_steps "$mode" <(printf '%s\n' "$fixture"); then
    fail "$name must reject guards inherited from another YAML step"
  fi
}

assert_step_policy_rejects workflow-cache "Workflow cache policy" \
  $'steps: # inline comments are valid YAML\n  - if: github.ref == \'refs/heads/main\'\n    run: true\n  - uses: actions/cache/save@0123456789012345678901234567890123456789'
assert_step_policy_rejects action-cache "Composite action cache policy" \
  $'steps:\n  - if: inputs.save-cache == \'true\'\n    run: true\n  - uses: actions/cache@0123456789012345678901234567890123456789'
assert_step_policy_rejects workflow-cache "Negated workflow cache guard" \
  $'steps:\n  - uses: actions/cache/save@0123456789012345678901234567890123456789\n    if: github.ref != \'refs/heads/main\''
assert_step_policy_rejects action-cache "Disjunctive action cache guard" \
  $'steps:\n  - uses: actions/cache@0123456789012345678901234567890123456789\n    if: inputs.save-cache == \'true\' || github.ref != \'refs/heads/main\''
assert_step_policy_rejects checkout "Checkout credential policy" \
  $'steps:\n  - uses: actions/checkout@0123456789012345678901234567890123456789\n  - run: true\n    with:\n      persist-credentials: false'
assert_step_policy_rejects docker-sha "Docker action SHA policy" \
  $'steps:\n  - uses: "docker/login-action@main"'

assert_warmup_case() {
  local name="$1"
  local expected="$2"
  shift 2

  local actual
  actual="$(GITHUB_OUTPUT=/dev/stdout \
    "$script_dir/classify-ci-cache-warmup.sh" "$@")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Warmup classifier case failed: %s\nExpected:\n%s\nActual:\n%s\n' \
      "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

warmup_all_false=$(
  cat <<'EOF'
docker=false
executor_rust=false
node=false
python=false
wework_target=false
EOF
)
warmup_all_true="${warmup_all_false//false/true}"
assert_warmup_case "workflow change" "$warmup_all_true" \
  ".github/workflows/ci-cache-warmup.yml"

node_only="${warmup_all_false/node=false/node=true}"
node_and_wework_target="${node_only/wework_target=false/wework_target=true}"
assert_warmup_case "pnpm lock" "$node_and_wework_target" "pnpm-lock.yaml"
assert_warmup_case "workspace manifest" "$node_only" "pnpm-workspace.yaml"
assert_warmup_case "Wework manifest" "$node_only" "wework/package.json"
assert_warmup_case "Wework Electron manifest" "$node_and_wework_target" \
  "wework/electron/package.json"
assert_warmup_case "Wework Electron lock" "$node_and_wework_target" \
  "wework/electron/pnpm-lock.yaml"
assert_warmup_case "Claude CLI lock" "$node_only" \
  ".github/claude-code-cli/package-lock.json"

python_only="${warmup_all_false/python=false/python=true}"
assert_warmup_case "uv lock" "$python_only" "backend/uv.lock"

executor_lock="${warmup_all_false/docker=false/docker=true}"
executor_lock="${executor_lock/executor_rust=false/executor_rust=true}"
executor_lock="${executor_lock/wework_target=false/wework_target=true}"
assert_warmup_case "executor lock" "$executor_lock" "executor/Cargo.lock"

docker_only="${warmup_all_false/docker=false/docker=true}"
assert_warmup_case "Executor E2E resolver" "$docker_only" \
  ".github/scripts/resolve-executor-e2e-runtime.sh"

assert_executor_runtime_resolution() {
  local name="$1"
  local manifest_fixture="$2"
  local expected_base_digest="$3"
  local temp_dir
  local output_file
  local pinned_base_image
  local expected_runtime_digest

  temp_dir="$(mktemp -d)"
  output_file="$temp_dir/output"
  cat > "$temp_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 6 ||
  "$1" != "buildx" ||
  "$2" != "imagetools" ||
  "$3" != "inspect" ||
  "$5" != "--format" ||
  "$6" != "{{json .Manifest}}" ]]; then
  printf 'Unexpected docker invocation: %q ' "$@" >&2
  printf '\n' >&2
  exit 1
fi

printf '%s\n' "${DOCKER_MANIFEST_FIXTURE:?}"
EOF
  chmod +x "$temp_dir/docker"

  PATH="$temp_dir:$PATH" \
    BASE_IMAGE="ghcr.io/wecode-ai/base:test" \
    SOURCE_DIGEST="source-digest" \
    GITHUB_REPOSITORY_OWNER="WECODE-AI" \
    GITHUB_OUTPUT="$output_file" \
    DOCKER_MANIFEST_FIXTURE="$manifest_fixture" \
    "$script_dir/resolve-executor-e2e-runtime.sh"

  pinned_base_image="ghcr.io/wecode-ai/base:test@$expected_base_digest"
  expected_runtime_digest="$(
    printf '%s\n%s\n' "source-digest" "$pinned_base_image" |
      sha256sum |
      cut -d ' ' -f 1
  )"
  if ! grep -Fxq "base-image=$pinned_base_image" "$output_file" ||
    ! grep -Fxq \
      "image=ghcr.io/wecode-ai/wegent-e2e-claudecode-executor:$expected_runtime_digest" \
      "$output_file"; then
    printf 'Executor runtime resolution failed: %s\n' "$name" >&2
    cat "$output_file" >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  rm -rf "$temp_dir"
}

assert_executor_runtime_resolution "multi-platform image" \
  '{"digest":"sha256:index","manifests":[{"digest":"sha256:arm64","platform":{"os":"linux","architecture":"arm64"}},{"digest":"sha256:amd64","platform":{"os":"linux","architecture":"amd64"}}]}' \
  "sha256:amd64"
assert_executor_runtime_resolution "single-platform image" \
  '{"digest":"sha256:single","mediaType":"application/vnd.oci.image.manifest.v1+json"}' \
  "sha256:single"

desktop_image="${warmup_all_false/docker=false/docker=true}"
desktop_image="${desktop_image/wework_target=false/wework_target=true}"
assert_warmup_case "Wework desktop image" "$desktop_image" \
  "docker/wework-e2e/desktop.Dockerfile"

pr_workflows=(
  lint.yml
  test.yml
  e2e-tests.yml
  wework-e2e.yml
)

for workflow in "${pr_workflows[@]}"; do
  workflow_path="$workflow_dir/$workflow"

  if grep -q 'uses: actions/cache@' "$workflow_path"; then
    fail "$workflow must not automatically save branch-scoped caches"
  fi

  if grep -A4 'uses: actions/setup-node@' "$workflow_path" |
    grep -Eq '^[[:space:]]+cache:'; then
    fail "$workflow must not use setup-node automatic cache writes"
  fi

  if grep -q 'uses: astral-sh/setup-uv@' "$workflow_path"; then
    fail "$workflow must use the shared read-only Python cache action"
  fi

  if ! validate_yaml_steps workflow-cache "$workflow_path"; then
    fail "$workflow may save explicit caches only from main"
  fi
done

for action_file in "$action_dir"/*/action.yml; do
  if ! validate_yaml_steps action-cache "$action_file"; then
    fail "$action_file must gate cache writes on the save-cache input"
  fi
done

warmup_workflow="$workflow_dir/ci-cache-warmup.yml"
if ! grep -q '^  push:$' "$warmup_workflow" ||
  ! grep -A3 '^  push:$' "$warmup_workflow" | grep -q 'main'; then
  fail "CI cache warmup must run after matching changes enter main"
fi

if ! grep -A3 '^  changes:$' "$warmup_workflow" |
  grep -Fq "if: github.ref == 'refs/heads/main'"; then
  fail "CI cache warmup jobs must refuse non-main workflow dispatches"
fi

node_manifests=(
  frontend/package.json
  package.json
  "packages/*/package.json"
  pnpm-lock.yaml
  pnpm-workspace.yaml
  wework/package.json
)
for manifest in "${node_manifests[@]}"; do
  if ! grep -Fq -- "- \"$manifest\"" "$warmup_workflow"; then
    fail "CI cache warmup must watch Node workspace manifest $manifest"
  fi
done

python_action="$action_dir/setup-python-uv-cache/action.yml"
# GitHub expressions are matched literally in action source.
# shellcheck disable=SC2016
if ! grep -Fq 'default: "false"' "$python_action" ||
  ! grep -Fq "if: inputs.setup-python == 'true'" "$python_action" ||
  ! grep -Fq "if: inputs.setup-uv == 'true'" "$python_action" ||
  ! grep -Fq "if: inputs.save-cache == 'true'" "$python_action" ||
  ! grep -Fq 'uv-v1-python-${{ inputs.python-version }}' \
    "$python_action"; then
  fail "Python caches must be shared by version and read-only by default"
fi

sccache_action="$action_dir/setup-sccache/action.yml"
# Environment variables are matched literally in action source.
# shellcheck disable=SC2016
if ! grep -Fq 'SCCACHE_BASEDIRS=$GITHUB_WORKSPACE' "$sccache_action" ||
  ! grep -Fq 'continue-on-error: true' "$sccache_action" ||
  [[ "$(grep -Fc "if: steps.install.outcome == 'success'" \
    "$sccache_action")" -ne 2 ]] ||
  ! grep -Fq "if: steps.install.outcome != 'success'" "$sccache_action" ||
  ! grep -Fq 'continuing without Rust compiler caching' "$sccache_action" ||
  ! grep -Fq 'GitHub Actions cache credentials are unavailable for sccache' \
    "$sccache_action" ||
  ! grep -Fq 'SCCACHE_GHA_VERSION=wegent-sccache-v1-' "$sccache_action" ||
  ! grep -Fq 'SCCACHE_GHA_RW_MODE=READ_ONLY' "$sccache_action" ||
  ! grep -Fq 'refs/heads/main' "$sccache_action"; then
  fail "sccache must degrade safely and allow cache writes only from main"
fi

macos_warmup_section="$(
  sed -n \
    '/^  warm-wework-macos-electron:/,/^  prepare-wework-desktop-image:/p' \
    "$warmup_workflow"
)"
if [[ "$macos_warmup_section" != *'name: Warm Wework macOS Electron Build Cache'* ]] ||
  [[ "$macos_warmup_section" != *'runs-on: macos-14'* ]] ||
  [[ "$macos_warmup_section" != *"needs.changes.outputs.wework_target == 'true'"* ]] ||
  [[ "$macos_warmup_section" != *'uses: ./.github/actions/setup-sccache'* ]] ||
  [[ "$macos_warmup_section" != *'wework-electron-app-v1-'* ]] ||
  [[ "$macos_warmup_section" != *'pnpm-store-v2-'* ]] ||
  [[ "$macos_warmup_section" != *"'wework/electron/pnpm-lock.yaml'"* ]] ||
  [[ "$macos_warmup_section" != *'executor/target'* ]] ||
  [[ "$macos_warmup_section" != *'~/Library/Caches/electron'* ]] ||
  [[ "$macos_warmup_section" != *'pnpm --filter wework ai:verify:electron:build'* ]]; then
  fail "Wework macOS Electron builds must be prewarmed with the shared build cache"
fi

if grep -R -q 'type=gha' \
  "$workflow_dir/e2e-tests.yml" \
  "$workflow_dir/publish-image.yml" \
  "$workflow_dir/snapshot-image.yml"; then
  fail "Docker BuildKit caches must use GHCR instead of Actions cache storage"
fi

docker_cache_ref='wegent-executor:buildcache-e2e'
if ! grep -Fq "$docker_cache_ref" "$workflow_dir/e2e-tests.yml" ||
  ! grep -Fq "$docker_cache_ref" "$warmup_workflow"; then
  fail "Executor E2E jobs and warmup must use the same Docker cache"
fi

node_action="$action_dir/setup-node-workspace/action.yml"
workspace_manifests="hashFiles('pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'frontend/package.json', 'wework/package.json', 'packages/*/package.json')"
# GitHub expressions are matched literally in action source.
# shellcheck disable=SC2016
if ! grep -Fq 'node-24-workspace-v2-${{ hashFiles(' "$node_action" ||
  ! grep -Fq "$workspace_manifests" "$node_action" ||
  ! grep -Fq 'frontend/public/fonts' "$node_action" ||
  ! grep -Fq 'default: "false"' "$node_action" ||
  ! grep -Fq "if: inputs.setup-toolchain == 'true'" "$node_action" ||
  grep -Fq 'restore-keys:' "$node_action"; then
  fail "Node dependencies must use an exact, read-only-by-default workspace cache"
fi

# Shell source is matched literally in workflow source.
# shellcheck disable=SC2016
if ! validate_yaml_steps checkout "$warmup_workflow" ||
  ! grep -Fq 'git cat-file -e "$BEFORE_SHA^{commit}"' "$warmup_workflow"; then
  fail "Warmup checkouts must drop credentials and safely handle missing history"
fi

if ! ruby "$script_dir/lib/validate-ci-cache-policy.rb" docker-sha \
  "$warmup_workflow" \
  "$workflow_dir/e2e-tests.yml" \
  "$workflow_dir/wework-e2e.yml"; then
  fail "Docker actions introduced by cache workflows must be pinned by SHA"
fi

claude_cli_manifest=".github/claude-code-cli/package.json"
claude_cli_lock=".github/claude-code-cli/package-lock.json"
claude_cli_key="node-24-local-harness-clis-v2-\${{ hashFiles('$claude_cli_manifest', '$claude_cli_lock') }}"
claude_cli_verify=".github/scripts/verify-local-harness-clis.sh"
if [[ ! -f "$script_dir/../claude-code-cli/package.json" ]] ||
  [[ ! -f "$script_dir/../claude-code-cli/package-lock.json" ]] ||
  [[ ! -x "$script_dir/verify-local-harness-clis.sh" ]] ||
  ! grep -Fq "$claude_cli_key" "$warmup_workflow" ||
  ! grep -Fq "$claude_cli_key" "$workflow_dir/e2e-tests.yml" ||
  ! grep -Fq "$claude_cli_key" "$workflow_dir/wework-e2e.yml" ||
  ! grep -Fq "$claude_cli_verify" "$warmup_workflow" ||
  ! grep -Fq "$claude_cli_verify" "$workflow_dir/e2e-tests.yml" ||
  ! grep -Fq "$claude_cli_verify" "$workflow_dir/wework-e2e.yml" ||
  [[ "$(grep -Fl 'npm ci --prefix .github/claude-code-cli --strict-allow-scripts' \
    "$warmup_workflow" "$workflow_dir/e2e-tests.yml" \
    "$workflow_dir/wework-e2e.yml" | wc -l)" -ne 3 ]] ||
  grep -Eq 'npm install -g .*claude-code' \
    "$warmup_workflow" "$workflow_dir/e2e-tests.yml" \
    "$workflow_dir/wework-e2e.yml"; then
  fail "Local harness CLI caches must use the shared integrity-locked npm graph"
fi

for workflow in "${pr_workflows[@]}" ci-cache-warmup.yml; do
  if ! grep -Fq 'uses: ./.github/actions/setup-node-workspace' \
    "$workflow_dir/$workflow"; then
    fail "$workflow must consume the shared Node workspace cache"
  fi
done

# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if ! sed -n '/^  e2e-tests:/,/^  executor-e2e-tests:/p' \
  "$workflow_dir/e2e-tests.yml" |
  grep -F 'image: ${{ needs.prepare-platform-e2e-image.outputs.image }}' \
    >/dev/null ||
  ! sed -n '/^  e2e-tests:/,/^  executor-e2e-tests:/p' \
  "$workflow_dir/e2e-tests.yml" |
    grep -F 'setup-toolchain: "false"' >/dev/null ||
  ! sed -n '/^  e2e-tests:/,/^  executor-e2e-tests:/p' \
  "$workflow_dir/e2e-tests.yml" |
    grep -F 'setup-uv: "false"' >/dev/null ||
  sed -n '/^  e2e-tests:/,/^  executor-e2e-tests:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -E 'install-playwright-(browser|system-deps)' >/dev/null; then
  fail "Platform E2E shards must consume the immutable toolchain image without runtime installs"
fi

# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
  "$workflow_dir/e2e-tests.yml" |
  grep -F 'prepare-platform-e2e-image' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F \
    'PLATFORM_E2E_IMAGE: ${{ needs.prepare-platform-e2e-image.outputs.image }}' \
      >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F 'docker run --rm' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F -- '--network host' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F -- \
      '--volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE"' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F -- \
      '--volume "$GITHUB_WORKSPACE:$container_workspace"' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F 'container_workspace="/__w/$repository_name/$repository_name"' \
      >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F -- '--env E2E_BOOTSTRAP_ADMIN_PASSWORD' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F -- '--env E2E_CLAUDE_MODEL_SERVER_URL' >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F \
      'E2E_CLAUDE_EXECUTOR_IMAGE: ${{ needs.build-executor-e2e-runtime.outputs.artifact == '\''true'\'' && '\''wegent/e2e-claudecode-executor:latest'\'' || needs.build-executor-e2e-runtime.outputs.image }}' \
      >/dev/null ||
  ! sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F -- '--env E2E_CLAUDE_EXECUTOR_IMAGE' >/dev/null ||
  sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -E 'install-playwright-(browser|system-deps)' >/dev/null ||
  sed -n '/^  executor-e2e-tests:/,/^  merge-reports:/p' \
    "$workflow_dir/e2e-tests.yml" |
    grep -F 'playwright-chromium-v2-' >/dev/null; then
  fail "Executor E2E must run Playwright from the immutable dependency image"
fi

if grep -R -E \
  'install-playwright-(browser|system-deps)|playwright-chromium-v2-' \
  "$workflow_dir/e2e-tests.yml" "$warmup_workflow" >/dev/null; then
  fail "CI workflows must not install or cache Playwright outside dependency images"
fi

if ! grep -Fq 'docker/wework-e2e/browser.Dockerfile' \
  "$workflow_dir/e2e-tests.yml" ||
  ! grep -Fq 'does not match workspace version' \
    "$workflow_dir/e2e-tests.yml"; then
  fail "Platform E2E image preparation must pin and verify the Playwright version"
fi

wework_workflow="$workflow_dir/wework-e2e.yml"
wework_browser_image="$script_dir/../../docker/wework-e2e/browser.Dockerfile"
wework_desktop_image="$script_dir/../../docker/wework-e2e/desktop.Dockerfile"
if ! grep -Fq 'ARG UV_VERSION=0.11.17' "$wework_browser_image" ||
  ! grep -Fq '"https://astral.sh/uv/${UV_VERSION}/install.sh"' \
    "$wework_browser_image" ||
  ! grep -Fq 'uv --version' "$wework_browser_image"; then
  fail "The platform E2E image must provide the pinned uv toolchain"
fi

if ! grep -Fq 'file: docker/wework-e2e/browser.Dockerfile' "$wework_workflow" ||
  ! grep -Fq 'file: docker/wework-e2e/desktop.Dockerfile' "$wework_workflow" ||
  [[ "$(grep -c 'push: true' "$wework_workflow")" -ne 2 ]] ||
  grep -Eq 'playwright (install|install-deps)' \
    "$wework_workflow"; then
  fail "Wework E2E must consume its immutable dependency image without runtime installs"
fi

if ! grep -Fq 'libmagic1' "$wework_browser_image" ||
  ! grep -Fq 'zstd' \
  "$wework_browser_image" ||
  ! grep -Fq "ldconfig -p | grep -q 'libmagic\\.so\\.1'" \
    "$wework_browser_image" ||
  ! grep -Fq 'zstd --version' "$wework_browser_image"; then
  fail "Browser E2E images must include backend and artifact runtime libraries"
fi

if ! grep -Eq '^ENV IS_SANDBOX=1$' "$wework_desktop_image"; then
  fail "Wework desktop E2E must identify its root container as a Claude Code sandbox"
fi

# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
wework_target_key='wework-electron-e2e-v1-${{ hashFiles('\''docker/wework-e2e/desktop.Dockerfile'\'') }}-${{ hashFiles('\''executor/Cargo.lock'\'', '\''wework/electron/package.json'\'', '\''wework/electron/pnpm-lock.yaml'\'', '\''pnpm-lock.yaml'\'') }}'
if ! grep -Fq "$wework_target_key" "$workflow_dir/wework-e2e.yml" ||
  ! grep -Fq "$wework_target_key" "$warmup_workflow"; then
  fail "Wework E2E and warmup must share the Electron build cache"
fi

desktop_warmup_section="$(
  sed -n \
    '/^  warm-wework-desktop-target:/,/^  warm-executor-e2e-image:/p' \
    "$warmup_workflow"
)"
# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if [[ "$desktop_warmup_section" != *'image: ${{ needs.prepare-wework-desktop-image.outputs.desktop_image }}'* ]] ||
  [[ "$desktop_warmup_section" != *'HOME: /root'* ]] ||
  [[ "$desktop_warmup_section" != *'uses: ./.github/actions/setup-sccache'* ]] ||
  [[ "$desktop_warmup_section" != *'executor/target'* ]] ||
  [[ "$desktop_warmup_section" != *'~/.cache/electron'* ]] ||
  [[ "$desktop_warmup_section" != *'pnpm --filter wework ai:verify:electron:build'* ]] ||
  [[ "$desktop_warmup_section" =~ dtolnay/rust-toolchain ]]; then
  fail "Wework desktop Electron warmup must use shared build caches inside the E2E container"
fi

printf 'CI cache policy tests passed\n'
