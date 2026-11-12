# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

test_workflow="$script_dir/../workflows/test.yml"
if ! sed -n '/^  pull_request:/,/^  [a-z_]*:/p' "$test_workflow" |
  grep -q -- "- labeled"; then
  printf 'test.yml must run when the ci:all label is applied\n' >&2
  exit 1
fi

if ! grep -q "ci:all" "$test_workflow"; then
  printf 'test.yml must force all module tests for the ci:all label\n' >&2
  exit 1
fi

for workflow in e2e-tests.yml wework-e2e.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  pull_request_config="$(
    sed -n '/^  pull_request:/,/^  [a-z_]*:/p' "$workflow_path"
  )"
  if ! grep -q "ready_for_review" <<<"$pull_request_config"; then
    printf '%s must run E2E when a draft PR becomes ready for review\n' \
      "$workflow" >&2
    exit 1
  fi
  if ! grep -q "labeled" <<<"$pull_request_config"; then
    printf '%s must run when the ci:all label is applied\n' "$workflow" >&2
    exit 1
  fi
  if grep -q "paths:" <<<"$pull_request_config"; then
    printf '%s must not path-filter ci:all label events\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "ci:all" "$workflow_path"; then
    printf '%s must force E2E for the ci:all label\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "merge_group:" "$workflow_path"; then
    printf '%s must run for merge queue groups\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "checks_requested" "$workflow_path"; then
    printf '%s must limit merge group runs to checks_requested\n' \
      "$workflow" >&2
    exit 1
  fi
  if [[ "$workflow" == "wework-e2e.yml" ]]; then
    if ! grep -Fq "github.event.merge_group.base_sha" "$workflow_path" ||
      ! grep -Fq "github.event.merge_group.head_sha" "$workflow_path" ||
      ! grep -Fq "github.event_name != 'merge_group'" "$workflow_path" ||
      ! grep -Fq "grep -v '^\\.github/'" "$workflow_path"; then
      printf '%s must classify merge groups from their product diff\n' \
        "$workflow" >&2
      exit 1
    fi
  elif ! grep -Fq \
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" \
    "$workflow_path"; then
    printf '%s must reserve full E2E for scheduled, dispatched, or ci:all runs\n' \
      "$workflow" >&2
    exit 1
  fi
done

platform_e2e_workflow="$script_dir/../workflows/e2e-tests.yml"
provider_native_step="$(
  extract_named_workflow_step \
    "$platform_e2e_workflow" \
    "Run Provider-native E2E tests"
)"
if ! grep -Fq -- '--shard=${{ matrix.providerShardIndex }}/${{ matrix.shardTotal }}' \
  <<<"$provider_native_step" ||
  ! grep -Fq -- '--workers=1' <<<"$provider_native_step"; then
  printf 'Provider-native E2E must preserve serial execution while sharing all platform shards\n' >&2
  exit 1
fi

# Fork pull requests cannot pull the executor E2E image from GHCR: the Wework
# desktop build downloads executor-e2e-binary from this job instead, so the
# job must also run when a fork PR selects desktop E2E without platform_e2e.
# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if ! grep -Fq '.github/scripts/classify-wework-desktop-e2e.sh' \
  "$platform_e2e_workflow" ||
  ! grep -Fq 'wework_desktop_e2e: ${{ steps.classify.outputs.wework_desktop_e2e }}' \
    "$platform_e2e_workflow" ||
  ! grep -Fq "needs.changes.outputs.wework_desktop_e2e == 'true' && github.event.pull_request.head.repo.full_name != github.repository" \
  "$platform_e2e_workflow"; then
  printf 'e2e-tests.yml must build the executor E2E runtime for fork desktop E2E PRs\n' >&2
  exit 1
fi

for workflow in test.yml lint.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  if ! grep -q "merge_group:" "$workflow_path"; then
    printf '%s must publish its required summary in merge groups\n' "$workflow" >&2
    exit 1
  fi
  if [[ "$workflow" == "lint.yml" ]]; then
    if ! grep -Fq "if: github.event_name != 'merge_group'" "$workflow_path" ||
      ! grep -Fq "if: github.event_name == 'merge_group'" "$workflow_path" ||
      ! grep -Fq "name: Confirm E2E-only merge queue" "$workflow_path"; then
      printf '%s must replace module checks with one summary in merge groups\n' \
        "$workflow" >&2
      exit 1
    fi
  else
    unit_changes_job="$(sed -n '/^  changes:/,/^  test-backend:/p' "$workflow_path")"
    unit_summary_job="$(sed -n '/^  test-summary:/,$p' "$workflow_path")"
    if grep -Fq "if: github.event_name != 'merge_group'" \
      <<<"$unit_changes_job$unit_summary_job" ||
      grep -Fq '  merge-queue-summary:' "$workflow_path" ||
      grep -Fq 'name: Confirm E2E-only merge queue' "$workflow_path"; then
      printf 'test.yml must run real module checks and their summary in merge groups\n' >&2
      exit 1
    fi
    for job in test-backend test-backend-rs; do
      unit_test_job="$(awk -v target="  $job:" '
        $0 == target { found = 1; next }
        found && /^  [[:alnum:]-]+:/ { exit }
        found { print }
      ' "$workflow_path")"
      if grep -Fq "github.event_name != 'merge_group'" <<<"$unit_test_job" ||
        ! grep -Fq 'ref: ${{ github.event.pull_request.head.sha || github.sha }}' \
          <<<"$unit_test_job"; then
        printf '%s must test PR heads and queued merge commits\n' "$job" >&2
        exit 1
      fi
    done
  fi
  if ! grep -Fq "ci:all" "$workflow_path"; then
    printf '%s must keep full regression available through ci:all\n' "$workflow" >&2
    exit 1
  fi
done

# Exercise the workflow's real shell bodies instead of matching policy labels.
unit_test_workflow="$script_dir/../workflows/test.yml"
unit_classifier_script="$(
  extract_named_workflow_step_from_job \
    "$unit_test_workflow" "  changes:" "  test-backend:" \
    "Classify changed paths" |
    awk '/^        run: \|$/ { found = 1; next }
         found && /^          / { sub(/^          /, ""); print }'
)"
if [[ -z "$unit_classifier_script" ]]; then
  printf 'The unit-test classifier shell body must exist\n' >&2
  exit 1
fi
merge_outputs="$(
  EVENT_NAME=merge_group FORCE_ALL=false GITHUB_OUTPUT=/dev/stdout \
    bash -euo pipefail -c "$unit_classifier_script"
)"
if [[ "$merge_outputs" != $'backend=true\nbackend_rs=true' ]]; then
  printf 'Merge groups must require Backend and Rust without enabling unrelated modules\n' >&2
  exit 1
fi

unit_summary_script="$(
  extract_named_workflow_step "$unit_test_workflow" "Check test results" |
    awk '/^        run: \|$/ { found = 1; next }
         found && /^          / { sub(/^          /, ""); print }'
)"
if [[ -z "$unit_summary_script" ]]; then
  printf 'The unit-test summary shell body must exist\n' >&2
  exit 1
fi

assert_merge_summary_case() {
  local name="$1" expected="$2" backend_result="$3" rust_result="$4"
  local changes_result="${5-success}" backend_required="${6-true}"
  local rust_required="${7-true}" mysql_result="${8-success}"
  local rendered="$unit_summary_script" actual="failure"
  rendered="${rendered//'${{ needs.changes.result }}'/$changes_result}"
  rendered="${rendered//'${{ needs.changes.outputs.backend }}'/$backend_required}"
  rendered="${rendered//'${{ needs.changes.outputs.backend_rs }}'/$rust_required}"
  rendered="${rendered//'${{ needs.test-backend.result }}'/$backend_result}"
  rendered="${rendered//'${{ needs.test-backend-rs.result }}'/$rust_result}"
  rendered="${rendered//'${{ needs.test-plugin-auth-mysql.result }}'/$mysql_result}"
  rendered="$(sed -E \
    -e 's/\$\{\{ needs\.changes\.outputs\.[^ ]+ \}\}/false/g' \
    -e 's/\$\{\{ needs\.[^ ]+\.result \}\}/skipped/g' \
    <<<"$rendered")"
  if EVENT_NAME=merge_group bash -euo pipefail -c "$rendered" >/dev/null 2>&1; then
    actual="success"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'Merge summary case "%s": expected %s, got %s\n' \
      "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_merge_summary_case "all required jobs succeed" success success success
assert_merge_summary_case "Backend fails" failure failure success
assert_merge_summary_case "Backend is skipped" failure skipped success
assert_merge_summary_case "Rust fails" failure success failure
assert_merge_summary_case "Rust is skipped" failure success skipped
assert_merge_summary_case "classification fails" failure success success failure
assert_merge_summary_case "Backend output is missing" failure success success success ""
assert_merge_summary_case "Rust output is missing" failure success success success true ""
assert_merge_summary_case "MySQL is skipped" failure success success success true true skipped

plugin_auth_workflow="$script_dir/../workflows/plugin-auth-sdk.yml"
if workflow_has_top_level_trigger "$plugin_auth_workflow" "push"; then
  printf 'plugin-auth-sdk.yml must not repeat merge queue validation after entering main\n' >&2
  exit 1
fi
if workflow_has_top_level_trigger "$plugin_auth_workflow" "merge_group"; then
  printf 'plugin-auth-sdk.yml must not run in the merge queue\n' >&2
  exit 1
fi
plugin_auth_gated_job_count="$(
  grep -Fc "if: needs.changes.outputs.plugin_auth_sdk == 'true'" \
    "$plugin_auth_workflow"
)"
if ! grep -Fq "ci:all" "$plugin_auth_workflow" ||
  [[ "$plugin_auth_gated_job_count" -ne 3 ]]; then
  printf 'plugin-auth-sdk.yml must be path-scoped and full under ci:all\n' >&2
  exit 1
fi

assert_workflow_trigger_case "block mapping push trigger" "true" $'on:\n  push:\n  pull_request:'
assert_workflow_trigger_case "block mapping with on comment" "true" $'on: # workflow triggers\n  push:\n  pull_request:'
assert_workflow_trigger_case "block sequence push trigger" "true" $'on:\n  - push\n  - pull_request'
assert_workflow_trigger_case "inline scalar push trigger" "true" "on: push"
assert_workflow_trigger_case "inline array push trigger" "true" "on: [push, pull_request]"
assert_workflow_trigger_case "push job is not a trigger" "false" $'on: pull_request\njobs:\n  push:\n    runs-on: ubuntu-latest'

for workflow in lint.yml test.yml e2e-tests.yml wework-e2e.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  summary_condition="$(awk '
    /^  [[:alnum:]-]+-summary:/ { in_summary = 1; next }
    in_summary && /^    if:/ { print; exit }
  ' "$workflow_path")"
  if [[ "$summary_condition" != *"always() && !cancelled()"* ]]; then
    printf '%s must report failures while allowing superseded summaries to cancel\n' \
      "$workflow" >&2
    exit 1
  fi
  if workflow_has_top_level_trigger "$workflow_path" "push"; then
    printf '%s must not repeat merge queue validation after entering main\n' \
      "$workflow" >&2
    exit 1
  fi
  # GitHub expressions are matched literally in workflow source.
  # shellcheck disable=SC2016
  if ! grep -Fq 'git diff --name-only "$BASE_SHA...$HEAD_SHA"' "$workflow_path"; then
    printf '%s must classify pull request changes from the merge base\n' \
      "$workflow" >&2
    exit 1
  fi
done

wework_workflow="$script_dir/../workflows/wework-e2e.yml"
desktop_budget_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" --all)"
node --input-type=module - "$wework_workflow" "$desktop_budget_output" <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const [workflowPath, classifierOutput] = process.argv.slice(2)
const workflow = readFileSync(workflowPath, 'utf8')
const outputs = Object.fromEntries(
  classifierOutput.trim().split('\n').map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  })
)
for (const [job, suite, budget] of [
  ['wework-desktop-core-e2e', 'core', 10],
  ['wework-desktop-windows-core-e2e', 'core', 10],
  ['wework-desktop-cloud-e2e', 'cloud', 8],
]) {
  const shards = JSON.parse(outputs[`wework_desktop_${suite}_e2e_matrix`]).include
  const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0]
  const capacity = Number(body?.match(/max-parallel: (\d+)/)?.[1])
  if (suite === 'cloud') {
    assert.equal(shards.length, 8, `${job}: preserve the original eight shared shards`)
  }
  assert.ok(shards.length <= budget, `${job}: avoid repeated per-shard setup overhead`)
  assert.ok(capacity >= shards.length, `${job}: all shards must fit in one scheduling wave`)
}
const permissionShard = JSON.parse(outputs.wework_desktop_core_e2e_matrix).include.find(
  shard => shard.segments.split(',').includes('permission-modes')
)
assert.equal(permissionShard?.id, 'core-4', 'Bounded permission fixtures must reuse an existing runner')
const cloudJob = workflow.split('\n  wework-desktop-cloud-e2e:\n')[1]?.split(/\n  [\w-]+:\n/)[0]
const minioSetup = cloudJob?.match(/- name: Set up real object storage for plugin sync recovery E2E\n([\s\S]*?)(?=\n      - name:)/)?.[1]
assert.ok(minioSetup?.includes('uses: ./.github/actions/setup-minio-e2e'))
for (const checkpoint of [
  'plugin-runtime-route-refresh',
  'plugin-background-sync-isolation',
  'plugin-periodic-reconcile',
]) {
  assert.ok(minioSetup.includes(`contains(matrix.segments, '${checkpoint}')`), `${checkpoint}: CI must prepare real object storage`)
}
NODE
node "$script_dir/test-wework-windows-ci.mjs"
node "$script_dir/test-wework-executor-debugger.mjs"
if [[ "$(grep -c "github.event.action != 'labeled'" "$wework_workflow")" -lt 2 ]]; then
  printf 'Wework non-memory E2E jobs must filter pull_request label events\n' >&2
  exit 1
fi

node --test "$script_dir/ci-scheduling.test.mjs"

if ! grep -q "name: Platform E2E Summary" \
  "$script_dir/../workflows/e2e-tests.yml"; then
  printf 'Platform E2E must expose a stable summary check\n' >&2
  exit 1
fi

if ! grep -q "name: Wework E2E Summary" "$wework_workflow"; then
  printf 'Wework E2E must expose a stable summary check\n' >&2
  exit 1
fi

if grep -Fq 'WEWORK_E2E_SKIP_TYPECHECK' "$desktop_build_flows" ||
  grep -Fq 'WEWORK_E2E_SKIP_TYPECHECK' "$wework_workflow"; then
  printf 'Prebuilt Electron E2E must not retain the obsolete typecheck bypass\n' >&2
  exit 1
fi

if ! grep -q "wework_desktop_core_e2e_matrix" "$wework_workflow" ||
  ! grep -q "wework_desktop_other_e2e_matrix" "$wework_workflow"; then
  printf 'Wework desktop E2E must use the split changed-feature matrices\n' >&2
  exit 1
fi

collaboration_frontend_setup_step="$(
  extract_named_workflow_step_from_job \
    "$wework_workflow" \
    "  wework-desktop-core-e2e:" \
    "  build-wework-desktop-windows-core-e2e:" \
    "Set up Collaboration frontend"
)"
if ! grep -Fq \
  "contains(matrix.segments, 'collaboration-shared-core')" \
  <<<"$collaboration_frontend_setup_step" ||
  ! grep -Fq 'uses: ./.github/actions/setup-node-workspace' \
    <<<"$collaboration_frontend_setup_step" ||
  ! grep -Fq 'setup-toolchain: "false"' \
    <<<"$collaboration_frontend_setup_step"; then
  printf 'Shared Collaboration Core E2E must restore frontend dependencies only on its owning shard\n' >&2
  exit 1
fi

core_build_job="$(
  sed -n '/^  build-wework-desktop-core-e2e:/,/^  wework-desktop-core-e2e:/p' \
    "$wework_workflow"
)"
desktop_other_job="$(
  sed -n '/^  wework-desktop-e2e:/,/^  wework-e2e-summary:/p' \
    "$wework_workflow"
)"
if [[ "$core_build_job" != *"restore-wework-core-e2e-build-oci.sh"* ]] ||
  [[ "$core_build_job" != *"uses: ./.github/actions/build-wework-core-e2e"* ]] ||
  [[ "$core_build_job" != *"uses: actions/upload-artifact@v4"* ]] ||
  ! grep -Fq "pnpm --filter wework ai:verify:electron:build" \
    "$wework_core_build_action" ||
  ! grep -Fq "wework/electron/release/WeWork-linux-x64/WeWork" \
    "$wework_core_build_action" ||
  ! grep -Fq "resources/bin/wegent-executor" "$wework_core_build_action" ||
  ! grep -Fq "restore-oci-runtime-binary.sh" "$wework_core_build_action" ||
  ! grep -Fq "RUNTIME_ARTIFACTS:" "$wework_core_build_action"; then
  printf 'The shared desktop E2E artifact must be built from the Electron package\n' >&2
  exit 1
fi

if [[ "$desktop_other_job" != *"build-wework-desktop-core-e2e"* ]] ||
  [[ "$desktop_other_job" != *"uses: actions/download-artifact@v6"* ]] ||
  [[ "$desktop_other_job" != *"electron-app/WeWork"* ]] ||
  [[ "$desktop_other_job" != *"electron-app/resources/bin/wegent-executor"* ]]; then
  printf 'Non-Core desktop E2E must consume the shared Electron package\n' >&2
  exit 1
fi

wework_browser_job="$(
  sed -n '/^  wework-e2e:/,/^  build-wework-desktop-core-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_browser_job" != *"needs.changes.outputs.wework_e2e == 'true'"* ]]; then
  printf 'Wework browser E2E must use the broad Wework change classification\n' >&2
  exit 1
fi
if [[ "$wework_browser_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework browser E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_changes_job="$(
  sed -n '/^  changes:/,/^  wework-e2e:/p' "$wework_workflow"
)"
# GitHub expressions and shell source are matched literally in workflow source.
# shellcheck disable=SC2016
if grep -Fq "prepare-wework-e2e-image" "$wework_workflow" ||
  [[ "$wework_changes_job" != *'browser_image: ${{ steps.image.outputs.browser-ref }}'* ]] ||
  [[ "$wework_changes_job" != *'desktop_image: ${{ steps.image.outputs.desktop-ref }}'* ]] ||
  [[ "$wework_changes_job" != *'docker manifest inspect "$IMAGE"'* ]] ||
  [[ "$wework_changes_job" != *"steps.browser-image-check.outputs.exists == 'false'"* ]] ||
  [[ "$wework_changes_job" != *"steps.desktop-image-check.outputs.exists == 'false'"* ]]; then
  printf 'Wework image resolution must share the change-detection job and build only misses\n' >&2
  exit 1
fi

wework_desktop_job="$(
  sed -n '/^  wework-desktop-e2e:/,/^  wework-e2e-summary:/p' "$wework_workflow"
)"
if [[ "$wework_desktop_job" != *"needs.changes.outputs.wework_desktop_other_e2e == 'true'"* ]]; then
  printf 'Wework non-Core desktop E2E must use its segment classification\n' >&2
  exit 1
fi
if [[ "$wework_desktop_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework non-Core desktop E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_desktop_cloud_job="$(
  sed -n '/^  wework-desktop-cloud-e2e:/,/^  wework-desktop-e2e:/p' "$wework_workflow"
)"
if [[ "$wework_desktop_cloud_job" != *"needs.changes.outputs.wework_desktop_cloud_e2e == 'true'"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"fromJSON(needs.changes.outputs.wework_desktop_cloud_e2e_matrix)"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"max-parallel: 15"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"--parallel-segments"* ]] ||
  [[ "$wework_desktop_cloud_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: "4"'* ]] ||
  [[ "$wework_desktop_cloud_job" != *"node .github/scripts/run-with-resource-logging.mjs"* ]] ||
  [[ "$wework_desktop_cloud_job" != *'WEWORK_E2E_ISOLATED_XVFB: "true"'* ]] ||
  [[ "$wework_desktop_cloud_job" != *"compression-level: 6"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"name: Download shared Wework desktop E2E build"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"uses: actions/download-artifact@v6"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"WEWORK_E2E_APP_BIN:"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"WEWORK_E2E_EXECUTOR_BIN:"* ]]; then
  printf 'Wework Cloud desktop E2E must run all prebuilt Cloud shards in one scheduling wave\n' >&2
  exit 1
fi
if [[ "$wework_desktop_cloud_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework Cloud desktop E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_desktop_core_job="$(
  sed -n '/^  wework-desktop-core-e2e:/,/^  build-wework-desktop-windows-core-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_desktop_core_job" != *"needs.changes.outputs.wework_desktop_core_e2e == 'true'"* ]] ||
  [[ "$wework_desktop_core_job" != *"max-parallel: 17"* ]] ||
  [[ "$wework_desktop_core_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: "4"'* ]] ||
  [[ "$wework_desktop_core_job" != *"node .github/scripts/run-with-resource-logging.mjs"* ]] ||
  [[ "$wework_desktop_core_job" != *"WEWORK_E2E_SCREENSHOTS:"* ]] ||
  [[ "$wework_desktop_core_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$wework_desktop_core_job" != *"compression-level: 6"* ]]; then
  printf 'Wework Core desktop E2E must run all prebuilt Core shards in one scheduling wave\n' >&2
  exit 1
fi
if [[ "$wework_desktop_core_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework Core desktop E2E must honor merge-group change classification\n' >&2
  exit 1
fi

for sandbox_job in "$wework_desktop_core_job" "$wework_desktop_cloud_job"; do
  if [[ "$sandbox_job" != *"--cap-add=SYS_ADMIN"* ]] ||
    [[ "$sandbox_job" != *".github/scripts/run-ci-mysqld.sh"* ]] ||
    [[ "$sandbox_job" != *"--security-opt seccomp=unconfined"* ]] ||
    [[ "$sandbox_job" != *"--security-opt apparmor=unconfined"* ]] ||
    [[ "$sandbox_job" != *"--security-opt systempaths=unconfined"* ]] ||
    [[ "$sandbox_job" != *"bash .github/scripts/verify-native-sandbox-namespaces.sh"* ]]; then
    printf 'Desktop E2E containers must support the real native sandbox namespaces\n' >&2
    exit 1
  fi
done

wework_windows_desktop_core_build_job="$(
  sed -n \
    '/^  build-wework-desktop-windows-core-e2e:/,/^  wework-desktop-windows-core-e2e:/p' \
    "$wework_workflow"
)"
wework_windows_build_action="$(cat "$repo_root/.github/actions/build-wework-windows-e2e/action.yml")"
wework_windows_desktop_core_build_job+="$wework_windows_build_action"
if [[ "$wework_windows_desktop_core_build_job" != *"runs-on: windows-latest"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"needs.changes.outputs.windows_desktop_core_e2e == 'true'"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"pnpm --filter wework ai:verify:electron:build"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"WeWork-win32-"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"inputs.arch"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/bin/wegent-executor.exe"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/codex/vendor"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"aarch64-pc-windows-msvc"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/wework-core-plugins.tar.gz"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/wework-app-static.tar.gz"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/bundled-plugins.tar.gz"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"include-hidden-files: true"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"REDIS_WINDOWS_VERSION: 8.10.1"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"REDIS_WINDOWS_SHA256: 4e8f2f956ed92feadf3f64b4e137ed34026438821e692e7ae22c9bba5976607a"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"name: wework-desktop-windows-redis-e2e-tools"* ]]; then
  printf 'Windows Wework Core desktop E2E must build a native packaged application\n' >&2
  exit 1
fi

wework_windows_desktop_core_job="$(
  sed -n '/^  wework-desktop-windows-core-e2e:/,/^  wework-desktop-cloud-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_windows_desktop_core_job" != *"runs-on: windows-latest"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"needs.changes.outputs.windows_desktop_core_e2e == 'true'"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"fromJSON(needs.changes.outputs.windows_desktop_core_e2e_matrix)"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"max-parallel: 17"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: "1"'* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"--parallel-segments"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_APP_BIN:"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_EXECUTOR_BIN:"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_CODEX_BIN:"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"wework-core-plugins.tar.gz"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"wework-app-static.tar.gz"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"bundled-plugins.tar.gz"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"name: wework-desktop-windows-redis-e2e-tools"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"uses: ./.github/actions/setup-python-uv-cache"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *'python-version: "3.12"'* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"shell: pwsh"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_REDIS_SERVER_BIN=\$redisServerPath"* ]] ||
  [[ "$wework_windows_desktop_core_job" == *"\$redisRoot | Out-File -FilePath \$env:GITHUB_PATH"* ]]; then
  printf 'Windows Wework Core desktop E2E must use all selected Core shards\n' >&2
  exit 1
fi

wework_summary_job="$(
  sed -n '/^  wework-e2e-summary:/,/^  wework-desktop-memory-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_summary_job" == *"RUN_DESKTOP_CORE_E2E: \${{ github.event_name != 'pull_request' ||"* ]] ||
  [[ "$wework_summary_job" == *"RUN_DESKTOP_CLOUD_E2E: \${{ github.event_name != 'pull_request' ||"* ]] ||
  [[ "$wework_summary_job" == *"RUN_DESKTOP_OTHER_E2E: \${{ github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework E2E summary must honor merge-group change classification\n' >&2
  exit 1
fi
if [[ "$wework_summary_job" != *"RUN_WINDOWS_DESKTOP_CORE_E2E:"* ]] ||
  [[ "$(grep -Fc "\"\$RUN_WINDOWS_DESKTOP_CORE_E2E\" == \"true\"" <<<"$wework_summary_job")" -ne 4 ]]; then
  printf 'Wework E2E summary must check Windows Core only when explicitly scheduled\n' >&2
  exit 1
fi

if grep -q '^  push:' "$wework_workflow"; then
  printf 'Wework E2E must not run the full suite after every main push\n' >&2
  exit 1
fi

if [[ "$wework_desktop_cloud_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$wework_desktop_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$(grep -Fc 'name: Prune transient Wework desktop E2E caches' "$wework_workflow")" -ne 6 ]]; then
  printf 'Wework desktop shards must avoid workspace dependency restores and prune transient caches\n' >&2
  exit 1
fi

managed_components_exclusion='!wework/test-results/desktop-e2e/**/managed-components/**'
if [[ "$(grep -Fc "$managed_components_exclusion" "$wework_workflow")" -ne 9 ]] ||
  [[ "$(grep -Fc "$managed_components_exclusion" \
    "$script_dir/../workflows/wework-app.yml")" -ne 1 ]]; then
  printf 'Every Wework desktop diagnostics upload must exclude materialized components\n' >&2
  exit 1
fi

test_archive_exclusion='!wework/test-results/desktop-e2e/**/*.zip'
if [[ "$(grep -Fc "$test_archive_exclusion" "$wework_workflow")" -ne 9 ]] ||
  [[ "$(grep -Fc "$test_archive_exclusion" \
    "$script_dir/../workflows/wework-app.yml")" -ne 1 ]]; then
  printf 'Every Wework desktop diagnostics upload must exclude test archives\n' >&2
  exit 1
fi

if [[ "$(grep -Fc 'compression-level: 6' "$wework_workflow")" -ne 10 ]] ||
  [[ "$(grep -Fc 'compression-level: 6' \
    "$script_dir/../workflows/wework-app.yml")" -ne 1 ]]; then
  printf 'Every Wework desktop diagnostics upload must compress retained evidence\n' >&2
  exit 1
fi

for generated_path_exclusion in \
  '!wework/test-results/desktop-e2e/**/managed-runtimes/**' \
  '!wework/test-results/desktop-e2e/**/dsh-core/profiles/**' \
  '!wework/test-results/desktop-e2e/**/harness-apps/instances/**/profiles/**' \
  '!wework/test-results/desktop-e2e/**/harness-runtime/**' \
  '!wework/test-results/desktop-e2e/**/node-runtime/**' \
  '!wework/test-results/desktop-e2e/**/WeWork-Electron-E2E-*.app/**'; do
  if [[ "$(grep -Fc "$generated_path_exclusion" "$wework_workflow")" -ne 6 ]]; then
    printf 'Wework desktop diagnostics must exclude generated Electron runtime files\n' >&2
    exit 1
  fi
done

if ! grep -Fq 'const DEFAULT_PARALLEL_CHECKPOINTS = 1' "$desktop_checkpoint_runner"; then
  printf 'Wework desktop E2E must default to one checkpoint per runner\n' >&2
  exit 1
fi

if grep -Fq 'cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES' "$desktop_build_flows" ||
  [[ "$(grep -Fc \
    'cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES' \
    "$cloud_checkpoint_flows")" -ne 1 ]]; then
  printf 'Cloud model protocol coverage must run once in its dedicated checkpoint\n' >&2
  exit 1
fi

if ! grep -q "github.event_name != 'merge_group'" "$wework_workflow"; then
  printf 'Wework memory E2E must remain outside regular merge groups\n' >&2
  exit 1
fi

wework_memory_job="$(
  sed -n '/^  wework-desktop-memory-e2e:/,$p' "$wework_workflow"
)"
wework_memory_job+="$(cat "$repo_root/.github/actions/build-wework-macos-e2e/action.yml")"
memory_step_gate="$(
  sed -n '/^      - name: Run Wework desktop memory E2E$/{n;p;}' "$wework_workflow"
)"
if [[ "$memory_step_gate" != "        if: github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'ci:all')" ]]; then
  printf 'Wework memory E2E must run only for ci:all PRs\n' >&2
  exit 1
fi

if [[ "$wework_memory_job" != *"pnpm-store-v2-"* ]] ||
  [[ "$wework_memory_job" != *"'wework/electron/pnpm-lock.yaml'"* ]] ||
  [[ "$wework_memory_job" != *"pnpm install --frozen-lockfile"* ]] ||
  [[ "$wework_memory_job" != *"pnpm --dir wework/electron install --frozen-lockfile"* ]] ||
  [[ "$wework_memory_job" == *"--offline"* ]]; then
  printf 'Wework memory E2E must allow dependency downloads when the macOS pnpm cache is incomplete\n' >&2
  exit 1
fi

