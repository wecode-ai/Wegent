# Sourced by test-classify-ci-changes.sh; retain complete shard matrices.

for dots_path in \
  wework/e2e/desktop/scenarios/dots-closed-loops.scenario.mjs \
  wework/e2e/desktop/modules/dots-story-fixtures.mjs \
  wework/src/features/workbench/workspaceLaunchRequest.ts; do
  assert_desktop_case "delegated delivery paths select their existing core shard: $dots_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"dots-closed-loops"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$dots_path"
done

assert_desktop_case "runtime task hydration retains all existing core and cloud coverage with delivery loops" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,task-status-sync"},{"id":"core-3","name":"Core / shard 3","segments":"dots-closed-loops"},{"id":"core-4","name":"Core / shard 4","segments":"task-board-bulk-actions"},{"id":"core-6","name":"Core / shard 6","segments":"runtime-task-queue"},{"id":"core-8","name":"Core / shard 8","segments":"workspace-attachments"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create,cloud-worktree-tools"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/useWorkbenchRuntimeTasks.ts"
