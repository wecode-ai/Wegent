# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

assert_desktop_case "local task consent and its scenario select the real remote task regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"remote-task-access"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/settings/RemoteTaskAccessSetting.tsx" \
  "wework/src/desktop/remoteTaskAccess.ts" \
  "executor/src/runtime_work/remote_task_access.rs" \
  "wework/e2e/desktop/scenarios/remote-task-access.scenario.mjs"
