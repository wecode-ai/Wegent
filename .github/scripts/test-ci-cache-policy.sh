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
wework_rust=false
wework_target=false
EOF
)
warmup_all_true="${warmup_all_false//false/true}"
assert_warmup_case "workflow change" "$warmup_all_true" \
  ".github/workflows/ci-cache-warmup.yml"

node_only="${warmup_all_false/node=false/node=true}"
assert_warmup_case "pnpm lock" "$node_only" "pnpm-lock.yaml"
assert_warmup_case "workspace manifest" "$node_only" "pnpm-workspace.yaml"
assert_warmup_case "Wework manifest" "$node_only" "wework/package.json"
assert_warmup_case "Claude CLI lock" "$node_only" \
  ".github/claude-code-cli/package-lock.json"

python_only="${warmup_all_false/python=false/python=true}"
assert_warmup_case "uv lock" "$python_only" "backend/uv.lock"

executor_lock="${warmup_all_false/docker=false/docker=true}"
executor_lock="${executor_lock/executor_rust=false/executor_rust=true}"
executor_lock="${executor_lock/wework_target=false/wework_target=true}"
assert_warmup_case "executor lock" "$executor_lock" "executor/Cargo.lock"

wework_lock="${warmup_all_false/wework_rust=false/wework_rust=true}"
wework_lock="${wework_lock/wework_target=false/wework_target=true}"
assert_warmup_case "Wework lock" "$wework_lock" \
  "wework/src-tauri/Cargo.lock"

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
  ! grep -Fq 'GitHub Actions cache credentials are unavailable for sccache' \
    "$sccache_action" ||
  ! grep -Fq 'SCCACHE_GHA_VERSION=wegent-sccache-v1-' "$sccache_action" ||
  ! grep -Fq 'SCCACHE_GHA_RW_MODE=READ_ONLY' "$sccache_action" ||
  ! grep -Fq 'refs/heads/main' "$sccache_action"; then
  fail "sccache must normalize paths and allow writes only from main"
fi

if ! grep -Fq 'name: Warm Wework macOS Rust Cache' "$warmup_workflow" ||
  ! grep -A90 'name: Warm Wework macOS Rust Cache' "$warmup_workflow" |
    grep -Fq 'runs-on: macos-14' ||
  ! grep -A90 'name: Warm Wework macOS Rust Cache' "$warmup_workflow" |
    grep -Fq 'uses: ./.github/actions/setup-sccache' ||
  ! grep -A90 'name: Warm Wework macOS Rust Cache' "$warmup_workflow" |
    grep -Fq 'task-flow.e2e.mjs --build-only'; then
  fail "Wework macOS memory builds must be prewarmed with the shared sccache"
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
  ! grep -Fq "if: inputs.setup-toolchain == 'true'" "$node_action"; then
  fail "Node dependencies and generated fonts must share a read-only-by-default cache"
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

claude_cli_lock=".github/claude-code-cli/package-lock.json"
claude_cli_key="node-24-claude-code-cli-v3-\${{ hashFiles('$claude_cli_lock') }}"
if [[ ! -f "$script_dir/../claude-code-cli/package.json" ]] ||
  [[ ! -f "$script_dir/../claude-code-cli/package-lock.json" ]] ||
  ! grep -Fq "$claude_cli_key" "$warmup_workflow" ||
  ! grep -Fq "$claude_cli_key" "$workflow_dir/e2e-tests.yml" ||
  grep -Eq 'npm install -g .*claude-code' \
    "$warmup_workflow" "$workflow_dir/e2e-tests.yml"; then
  fail "Claude Code CLI caches must use the shared integrity-locked npm graph"
fi

for workflow in "${pr_workflows[@]}" ci-cache-warmup.yml; do
  if ! grep -Fq 'uses: ./.github/actions/setup-node-workspace' \
    "$workflow_dir/$workflow"; then
    fail "$workflow must consume the shared Node workspace cache"
  fi
done

# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
playwright_key='playwright-chromium-v2-${{ steps.playwright-version.outputs.version }}'
if ! grep -Fq "$playwright_key" "$workflow_dir/e2e-tests.yml" ||
  ! grep -Fq "$playwright_key" "$warmup_workflow"; then
  fail "Platform E2E and warmup must share the Playwright browser cache"
fi

wework_workflow="$workflow_dir/wework-e2e.yml"
if ! grep -Fq 'file: docker/wework-e2e/browser.Dockerfile' "$wework_workflow" ||
  ! grep -Fq 'file: docker/wework-e2e/desktop.Dockerfile' "$wework_workflow" ||
  [[ "$(grep -c 'push: true' "$wework_workflow")" -ne 2 ]] ||
  grep -Eq 'playwright (install|install-deps)|install-wework-tauri-system-dependencies' \
    "$wework_workflow"; then
  fail "Wework E2E must consume its immutable dependency image without runtime installs"
fi

# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
wework_target_key='wework-desktop-e2e-v2-${{ hashFiles('\''executor/Cargo.lock'\'', '\''wework/src-tauri/Cargo.lock'\'') }}'
if ! grep -Fq "$wework_target_key" "$workflow_dir/wework-e2e.yml" ||
  ! grep -Fq "$wework_target_key" "$warmup_workflow"; then
  fail "Wework E2E and warmup must share the desktop Cargo target cache"
fi

printf 'CI cache policy tests passed\n'
