# Sourced by test-classify-ci-changes.sh; preserve native control coverage.

assert_desktop_case "workbench control runs its real native MCP checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"workbench-control"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/catalog/workbench-control.json" \
  "wework/e2e/desktop/scenarios/workbench-control.scenario.mjs" \
  "wework/e2e/desktop/modules/workbench-control-collaboration.mjs" \
  "executor/src/runtime_work/reader.rs" \
  "executor/src/workbench_control/catalog.rs" \
  "executor/src/runtime_work/handler/control/execution.rs" \
  "executor/src/runtime_work/handler/creation.rs" \
  "executor/src/runtime_work/handler/creation/models.rs" \
  "backend/app/services/runtime_continuation.py"

assert_desktop_case "shared control transports retain full desktop coverage" \
  "$full_desktop_expected" \
  "executor/src/local/backend/socket_transport.rs" \
  "executor/src/runtime_work/transcript_transport.rs"
