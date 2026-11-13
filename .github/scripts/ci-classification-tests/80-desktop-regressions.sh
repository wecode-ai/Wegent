# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

native_setup_expected="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" --all)"
for path in .github/actions/setup-wework-native-test-dependencies/action.yml \
  .github/ci/wework-native-test-ubuntu.sources; do
  assert_desktop_case "Native preparation keeps all desktop consumers covered: $path" \
    "$native_setup_expected" "$path"
done

for path in \
  wework/e2e/desktop/modules/harness-tool-result-order.mjs \
  wework/e2e/desktop/modules/harness-tool-result-order.d.mts; do
  assert_desktop_case "harness result order selects its real CLI checkpoint: $path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"local-harness"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$path"
done

assert_desktop_case "goal synchronization regression has CI coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"goal-state-sync"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/goal-state-sync.scenario.mjs"

assert_desktop_case "catalog recovery regression has CI coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"codex-invalid-launch-cwd"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/model-catalog-recovery.mjs"

for path in \
  wework/e2e/desktop/scenarios/follow-up-task-switch.scenario.mjs \
  wework/e2e/desktop/modules/follow-up-agent-history.mjs; do
  assert_desktop_case "follow-up identity regression has CI coverage: $path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"follow-up-task-switch"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$path"
done

assert_desktop_case "pane goal updates select conversation and goal synchronization coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"goal-state-sync,native-lifecycle"},{"id":"core-8","name":"Core / shard 8","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/useWorkbenchPaneSession.ts"

assert_desktop_case "goal reconciliation retains lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"goal-state-sync,native-lifecycle"},{"id":"core-2","name":"Core / shard 2","segments":"resilience"},{"id":"core-6","name":"Core / shard 6","segments":"running-sidebar-state"},{"id":"core-7","name":"Core / shard 7","segments":"supervisor-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStreamCoordinator.tsx"


assert_desktop_case "personal stand-in runs in a CI-covered real backend checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"stand-in-personal-task"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/stand-in-personal-task.scenario.mjs"

assert_desktop_case "drawer frame assertions run without competing Electron checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"collaboration-shared-core"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-shared-core.scenario.mjs"

assert_desktop_case "delivery snapshots run their registered desktop checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"collaboration-deliveries,collaboration-delivery-editing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-deliveries.scenario.mjs"

for delivery_render_path in \
  "packages/collaboration/src/issue-detail/IssueExecutionLists.tsx" \
  "packages/collaboration/src/SharedIssueDetailEditor.tsx" \
  "packages/collaboration/src/issue-detail/createSharedIssueDetailPort.ts" \
  "packages/collaboration/src/dto-mappers/workspaceDtoMappers.ts"; do
  delivery_render_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$delivery_render_path")"
  if [[ "$delivery_render_output" != *collaboration-deliveries* ]]; then
    printf 'Delivery rendering must select its regression checkpoint: %s\n%s\n' \
      "$delivery_render_path" "$delivery_render_output" >&2
    exit 1
  fi
done

printf 'CI change classifier tests passed\n'

assert_desktop_case "MCP App changes run the real desktop protocol checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"mcp-apps"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/mcp-apps/McpAppHost.tsx"

assert_desktop_case "Ordinary MCP regression changes run the real desktop protocol checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"mcp-apps"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/ordinary-mcp-regression.mjs"

for native_scenario in \
  wework/e2e/desktop/scenarios/native-lifecycle.scenario.mjs \
  wework/e2e/desktop/scenarios/native-guidance.scenario.mjs; do
  assert_desktop_case "native lifecycle regression is covered by the shared Core CI runner: $native_scenario" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"native-lifecycle"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "$native_scenario"
done

for telemetry_scenario in \
  wework/e2e/desktop/scenarios/telemetry-policy.scenario.mjs \
  wework/e2e/desktop/scenarios/stand-in-telemetry.scenario.mjs; do
  assert_desktop_case "Telemetry scenarios run the telemetry checkpoint: $telemetry_scenario" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in-telemetry"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$telemetry_scenario"
done

assert_desktop_case "Backlog scenario runs its independent Core checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"collaboration-board-backlog"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-board-backlog.scenario.mjs"

for suffix in '' '_tests'; do
  handler_path="executor/src/runtime_work/handler/stand_in_processing${suffix}.rs"
  handler_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$handler_path")"
  node --input-type=module - "$handler_path" "$handler_output" <<'NODE'
import assert from 'node:assert/strict'

const [path, output] = process.argv.slice(2)
const matrix = output.split('\n').find(line => line.startsWith('wework_desktop_core_e2e_matrix='))
const checkpoints = JSON.parse(matrix.slice(matrix.indexOf('=') + 1)).include
  .flatMap(entry => entry.segments.split(','))
for (const checkpoint of ['stand-in-profile', 'stand-in-permissions', 'collaboration-local-agent-dispatch', 'collaboration-remote-agent-dispatch']) {
  assert(checkpoints.includes(checkpoint), `${path} must select ${checkpoint}`)
}
NODE
done

coordination_router_expected="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "executor/src/runtime_work/handler/stand_in_processing.rs")"
for coordination_path in \
  "wework/dsh/coordination-runtime/router.js" \
  "wework/dsh/coordination-runtime/runtime.js" \
  "wework/dsh/coordination-runtime/instructions.js" \
  "wework/dsh/coordination-runtime/router.test.mjs" \
  "executor/src/runtime_work/handler/coordination_rpc.rs" \
  "executor/src/runtime_work/handler/stand_in_arrangements.rs" \
  "executor/src/runtime_work/handler/stand_in_arrangements_tests.rs" \
  "executor/src/task_runtime/coordination_arrangements.rs" \
  "wework/e2e/desktop/scenarios/coordination-arrangements.scenario.mjs" \
  "wework/e2e/desktop/scenarios/coordination-runtime.scenario.mjs"; do
  assert_desktop_case "Coordination routing retains dispatch and permission coverage: $coordination_path" \
    "$coordination_router_expected" "$coordination_path"
done

project_publication_expected="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "wework/e2e/desktop/scenarios/stand-in-processing.scenario.mjs")"
for publication_path in \
  "wework/src/features/todo/ProjectCoordinatorConversation.tsx" \
  "wework/src/features/todo/ProjectCoordinatorPublication.tsx" \
  "wework/src/features/todo/ProjectCoordinatorPublication.test.tsx" \
  "wework/src/features/todo/ProjectCoordinationPanel.tsx" \
  "wework/src/features/todo/ProjectCoordinationPanel.test.tsx" \
  "executor/src/runtime_work/handler/project_router.rs" \
  "executor/src/runtime_work/handler/project_router_assessment.rs" \
  "executor/src/runtime_work/handler/project_router_tests.rs" \
  "executor/src/task_runtime/project_router_store.rs" \
  "executor/src/runtime_work/handler/project_coordinator.rs" \
  "executor/src/task_runtime/store/project_coordinator.rs" \
  "executor/src/task_runtime/coordination_store.rs" \
  "wework/e2e/desktop/scenarios/project-coordinator-publication.scenario.mjs"; do
  assert_desktop_case "Project publication and routing storage retain their profile and permission checks: $publication_path" \
    "$project_publication_expected" "$publication_path"
done

for registration_path in \
  "wework/dsh/coordination-runtime/index.js" \
  "wework/dsh/coordination-runtime/package.json" \
  "wework/dsh/coordination-runtime/cordis.patch.yml"; do
  registration_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$registration_path")"
  node --input-type=module - "$registration_path" "$registration_output" <<'NODE'
import assert from 'node:assert/strict'
const [path, output] = process.argv.slice(2)
const values = Object.fromEntries(output.trim().split('\n').map(line => {
  const offset = line.indexOf('=')
  return [line.slice(0, offset), line.slice(offset + 1)]
}))
const checkpoints = JSON.parse(values.wework_desktop_core_e2e_matrix).include.flatMap(entry => entry.segments.split(','))
for (const checkpoint of ['stand-in-profile', 'stand-in-permissions', 'collaboration-local-agent-dispatch', 'collaboration-remote-agent-dispatch', 'release-package-startup', 'core-dsh-plugin-management']) {
  assert(checkpoints.includes(checkpoint), `${path} must select ${checkpoint}`)
}
assert.equal(values.wework_desktop_cloud_e2e, 'false')
assert.equal(values.wework_desktop_other_e2e, 'false')
NODE
done

unknown_feature_expected="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "wework/src/features/todo/UnclassifiedFuturePanel.tsx")"
assert_desktop_case "Unknown future coordinator features keep the conservative fallback" \
  "$unknown_feature_expected" "wework/src/features/todo/ProjectCoordinatorFutureAutomation.tsx"
assert_desktop_case "Parent board scenario runs its independent Core checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"collaboration-parent-board"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-parent-board.scenario.mjs"

for parent_board_path in \
  "packages/collaboration/src/project-board/ProjectBoardParentRows.tsx" \
  "packages/collaboration/src/issue-detail/IssueHierarchySummary.tsx" \
  "wework/src/features/todo/CloudTodoWorkspace.tsx"; do
  parent_board_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$parent_board_path")"
  if [[ "$parent_board_output" != *collaboration-parent-board* ]]; then
    printf 'Parent board path did not select its checkpoint: %s\n' "$parent_board_path" >&2
    exit 1
  fi
done

for path in .github/scripts/prime-ci-electron-installer-cache.mjs \
  .github/actions/prepare-electron-installer-cache/action.yml \
  wework/scripts/lib/electron-installer-cache.mjs; do
  assert_desktop_case "Electron installer cache selects its native Core consumers: $path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"workbench-mode,native-window-startup"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' "$path"
done

assert_desktop_case "E2E dependency installer selects only its desktop consumers" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in-email"},{"id":"core-5","name":"Core / shard 5","segments":"native-window-startup"},{"id":"core-10","name":"Core / shard 10","segments":"plugin-development"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-account-auth-coordination"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  ".github/scripts/install-e2e-apt-packages.sh"

for email_path in \
  "wework/e2e/desktop/scenarios/stand-in-email.scenario.mjs" \
  "wework/e2e/desktop/modules/real-mail-server.mjs" \
  "wework/src/features/todo/StandInEmailConnections.tsx" \
  "wework/dsh/connection-runtime/email-provider.js"
do
  assert_desktop_case "email user story is invoked by CI: $email_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in-email"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$email_path"
done
