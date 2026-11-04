# Sourced by test-classify-ci-changes.sh; reuse the existing CI shard assertions.

for connection_path in \
  "executor/src/task_runtime/connection_rules.rs" \
  "executor/src/runtime_work/handler/connection_identity.rs" \
  "packages/collaboration/src/automation/ConnectionRuleFields.tsx" \
  "wework/e2e/desktop/scenarios/connection-automations.scenario.mjs" \
  "wework/e2e/desktop/scenarios/connection-automation-cloud-host.scenario.mjs" \
  "wework/e2e/desktop/fixtures/connection-automation-provider.mjs"; do
  assert_desktop_case "connection rules retain local and cloud lifecycle coverage: $connection_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in-plugin-bridge"},{"id":"core-8","name":"Core / shard 8","segments":"stand-in-cloud"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$connection_path"
done
