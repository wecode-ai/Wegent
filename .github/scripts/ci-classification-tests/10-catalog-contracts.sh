# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

for runtime_workflow in e2e-tests.yml wework-e2e.yml ci-cache-warmup.yml; do
  if ! grep -Fq "$backend_rs_runtime_inputs" "$repo_root/.github/workflows/$runtime_workflow"; then
    printf 'Backend Rust runtime producer and consumers must hash the same source inputs: %s\n' \
      "$runtime_workflow" >&2
    exit 1
  fi
done
wework_app_workflow="$repo_root/.github/workflows/wework-app.yml"
wework_core_build_action="$repo_root/.github/actions/build-wework-core-e2e/action.yml"

assert_invalid_catalog_shard_rejected() {
  local lane="$1"
  local checkpoint="$2"
  local expected="$3"
  node --input-type=module - "$repo_root" "$lane" "$checkpoint" "$expected" <<'NODE_TEST'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
const [root, lane, checkpoint, expected] = process.argv.slice(2)
const { readDesktopCheckpointDefinitions, buildDesktopCheckpointCatalog } = await import(
  pathToFileURL(root + '/wework/e2e/desktop/checkpoint-catalog.mjs')
)
const entries = readDesktopCheckpointDefinitions()
delete entries.find(entry => entry.id === checkpoint).ci[lane].shard
assert.throws(() => buildDesktopCheckpointCatalog(entries), error => error.message === expected)
NODE_TEST
}

assert_invalid_catalog_shard_rejected core local-file-preview \
  'Core segment missing from core_shards: local-file-preview'
assert_invalid_catalog_shard_rejected core python-runtime \
  'Core segment missing from core_shards: python-runtime'
assert_invalid_catalog_shard_rejected cloud plugin-auto-update \
  'Cloud segment missing from cloud_shards: plugin-auto-update'

assert_plugin_auth_case() {
  local name="$1"
  local expected="$2"
  shift 2

  local output
  output="$(GITHUB_OUTPUT=/dev/stdout "$plugin_auth_classifier" "$@")"
  if [[ "$output" != "plugin_auth_sdk=$expected" ]]; then
    printf 'Plugin auth case "%s" failed: %s\n' "$name" "$output" >&2
    exit 1
  fi
}

assert_plugin_auth_case "unrelated Wework change" false \
  "wework/src/App.tsx"
assert_plugin_auth_case "native auth source" true \
  "executor/src/plugin_account_auth/mod.rs"
assert_plugin_auth_case "explicit full regression" true --all

assert_checkpoint_runtime_failure_rejected() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  printf '#!/bin/sh\nexit 23\n' > "$temp_dir/node"
  chmod +x "$temp_dir/node"
  if PATH="$temp_dir:$PATH" GITHUB_OUTPUT="$temp_dir/output" "$desktop_classifier" --all \
    >"$temp_dir/stdout" 2>"$temp_dir/stderr"; then
    printf 'Desktop classifier ignored a failed checkpoint runtime\n' >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  if ! grep -Fq 'Could not load registered desktop checkpoints' "$temp_dir/stderr"; then
    cat "$temp_dir/stderr" >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  rm -rf "$temp_dir"
}

assert_checkpoint_runtime_failure_rejected

if ! grep -Fq 'node wework/scripts/verify-release-upgrades.mjs' "$wework_app_workflow" ||
  ! grep -Fq 'diagnosticCheckpoint || upgradeVerificationCheckpoint(platform)' \
    "$repo_root/wework/scripts/verify-release-upgrades.mjs"; then
  printf 'The formal release verifier must invoke the registered platform upgrade checkpoints\n' >&2
  exit 1
fi


if ! grep -Fq 'const NOISE_DELTA_COUNT = 2200' "$notification_isolation_scenario" ||
  ! grep -Fq 'const BURST_RENDER_TIMEOUT_MS = 30_000' "$notification_isolation_scenario"; then
  printf 'Codex notification isolation must retain its 2200-delta stress case and targeted 30-second render budget\n' >&2
  exit 1
fi

if ! grep -Fq 'const MEMORY_RESPONSE_TIMEOUT_MS = 30_000' "$memory_tool_flows" ||
  ! grep -Fq 'Date.now() - startedAt < MEMORY_RESPONSE_TIMEOUT_MS' "$memory_tool_flows"; then
  printf 'Wework memory E2E must use its targeted 30-second streaming response budget\n' >&2
  exit 1
fi

