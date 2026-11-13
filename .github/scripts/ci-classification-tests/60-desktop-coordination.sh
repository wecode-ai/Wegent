# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

assert_desktop_case "collaboration coordinate scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"collaboration-local-group-coordinate"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-local-group-coordinate.scenario.mjs"

assert_desktop_case "collaboration first-use scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"collaboration-first-use"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-first-use.scenario.mjs"

assert_desktop_case "collaboration group onboarding scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-group-onboarding"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-group-onboarding.scenario.mjs"

assert_desktop_case "template components retain group onboarding coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-group-onboarding"},{"id":"core-10","name":"Core / shard 10","segments":"collaboration-templates,collaboration-template-lifecycle,collaboration-template-agents,collaboration-template-app-device-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "packages/collaboration/src/templates/TemplateCreateSection.tsx"

assert_desktop_case "collaboration human round scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"collaboration-human-round-resume"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-human-round-resume.scenario.mjs"

assert_desktop_case "collaboration cancellation scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"collaboration-local-group-cancellation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-local-group-cancellation.scenario.mjs"

assert_desktop_case "remote manager planning details E2E changes select regression coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"collaboration-remote-group-planning-details"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-remote-group-planning-details.scenario.mjs"

assert_desktop_case "project assignment notification E2E changes select assignment coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-assignment-notification"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/project-assignment-notification.scenario.mjs"

project_member_overrides_expected='wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-member-overrides"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}'

for permission_path in \
  wework/e2e/desktop/scenarios/project-member-overrides.scenario.mjs \
  backend/app/services/cloud_projects/members.py \
  backend/app/services/cloud_project_visibility.py \
  backend/app/services/collaboration_permissions.py \
  backend/app/services/issue_assignments.py \
  backend/tests/services/test_loop_item_assignment.py \
  backend/tests/api/test_collaboration_permission_contract.py; do
  assert_desktop_case "project permission changes select the override checkpoint: $permission_path" \
    "$project_member_overrides_expected" "$permission_path"
done

# Rust ownership already selects the full real desktop suite. Its shared matrix
# must keep this checkpoint in both the Linux and Windows jobs.
for permission_path in \
  backend-rs/src/cloud_projects.rs \
  backend-rs/src/cloud_projects/collaboration_access.sql; do
  assert_desktop_case "Rust project authorization retains override coverage: $permission_path" \
    "$full_desktop_expected" "$permission_path"
done

assert_desktop_case "browser E2E changes avoid desktop jobs" \
  'wework_desktop_e2e=false
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/tests/workbench.spec.ts"

assert_desktop_case "cloud files select only the cloud suite" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-runtime-path-recovery,plugin-legacy-upgrade,plugin-uninstall-lost-response,embedded-browser,cloud-project-creation,automation-lifecycle,browser-multi-tabs"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow,goal-lifecycle,supervisor-lifecycle,priority-filter,cloud-worktree-create,plugin-toggle-persistence,cloud-worktree-tools,cloud-model-presets,responses-tool-compatibility"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-auto-update,resilience,workspace-tabs,plugin-workspace-publication,plugin-write-coordination,workspace-attachments,cloud-device-lifecycle,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"model-routing,conversation-state,plugin-uninstall-unknown-result,cloud-model-recovery,rendering-extensions,telemetry-consent,plugin-registration-coordination,stand-in-cloud-device"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"window-lifecycle,plugin-uninstall-reinstall-race,project-automation,cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel,task-model-deletion"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-composer-long-list,plugin-collaboration-composer-isolation,plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile,plugin-package-integrity-recovery"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/cloud-connection/CloudConnectionProvider.tsx"

assert_desktop_case "cloud device lifecycle files select managed restart coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-device-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/settings/ConnectionsSettingsPage.tsx" \
  "wework/src/components/settings/DeviceVersionBadge.tsx" \
  "wework/src/features/cloud-devices/useDeviceOfflineLifecycleAction.ts" \
  "wework/e2e/desktop/modules/cloud-device-lifecycle-flow.mjs"

assert_desktop_case "worktree UI changes select local launch and cloud lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"},{"id":"core-8","name":"Core / shard 8","segments":"workspace-attachments"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create,cloud-worktree-tools"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/worktree-availability.ts"

assert_desktop_case "task status projection changes select status synchronization coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-status-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/projectTaskTracking.ts"

assert_desktop_case "workbench context changes select send shortcut coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-status-sync"},{"id":"core-7","name":"Core / shard 7","segments":"send-key-preference"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/workbenchContextTypes.ts"

assert_desktop_case "workbench provider changes select send shortcut and idle request coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,goal-state-sync,native-lifecycle"},{"id":"core-5","name":"Core / shard 5","segments":"idle-executor-requests"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"},{"id":"core-7","name":"Core / shard 7","segments":"send-key-preference"},{"id":"core-8","name":"Core / shard 8","segments":"workspace-attachments"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create,cloud-worktree-tools"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/WorkbenchProvider.tsx"

assert_desktop_case "workbench cloud context changes select non-blocking composer coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-status-sync"},{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"},{"id":"core-8","name":"Core / shard 8","segments":"cloud-context-resilience"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/useWorkbenchCloudProjectContext.ts"

assert_desktop_case "task board association UI changes select dedicated coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-status-sync"},{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/TaskBoardAssociationDialog.tsx"

assert_desktop_case "draft first-message regression is invoked by CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/new-task-board-association.mjs"

assert_desktop_case "personal Issue permission regression is invoked by CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"collaboration-issue-mcp-comments"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/personal-issue-access.mjs" \
  "wework/e2e/desktop/scenarios/collaboration-issue-mcp-comments.scenario.mjs"

assert_desktop_case "shared real object storage selects plugin recovery and collaboration consumers" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"collaboration-issue-mcp-comments"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/real-object-storage.mjs"

assert_desktop_case "dispatch Issue boundary regression is invoked by CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-remote-agent-dispatch"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/dispatch-issue-boundary.mjs"

assert_desktop_case "blocked comment archive stays in the cloud dispatch CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-remote-agent-dispatch"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/unconfigured-issue-archive.mjs"

assert_desktop_case "workspace Agent setup selects local and cloud dispatch coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"collaboration-local-agent-dispatch"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-remote-agent-dispatch"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/workspace-agent-setup.mjs"

assert_desktop_case "local assignee recovery stays in the dispatch CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"collaboration-local-agent-dispatch"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/local-issue-assignee-recovery.mjs"

assert_desktop_case "local status automation reuses the existing dispatch CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"collaboration-local-agent-dispatch"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-local-status-automation.scenario.mjs"

assert_desktop_case "MCP result parsing selects discovery and both real permission scenarios" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-space-tool-discovery"},{"id":"core-6","name":"Core / shard 6","segments":"collaboration-issue-mcp-comments"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-remote-agent-dispatch"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/mcp-tool-results.mjs"

assert_desktop_case "task board bulk action changes select dedicated coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"task-board-bulk-actions"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/TaskBoardView.tsx" \
  "wework/src/features/workbench/runtimeTaskArchive.ts" \
  "wework/e2e/desktop/scenarios/task-board-bulk-actions.scenario.mjs"

assert_desktop_case "backend runtime Worktree changes select the cloud lifecycle checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create,cloud-worktree-tools"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "backend/app/services/device/runtime_route.py"

assert_desktop_case "runtime task queue scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"runtime-task-queue"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/runtime-task-queue.scenario.mjs"

assert_desktop_case "send key preference scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"send-key-preference"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/send-key-preference.scenario.mjs"

assert_desktop_case "system proxy scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"system-proxy"},{"id":"core-2","name":"Core / shard 2","segments":"system-pac"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/system-pac.scenario.mjs" \
  "wework/e2e/desktop/scenarios/system-proxy.scenario.mjs" \
  "wework/electron/src/host/system-proxy.ts" \
  "wework/src/components/settings/ProxySettingsPage.tsx" \
  "wework/src/desktop/systemProxy.ts"

assert_desktop_case "Codex startup history regression independently selects its CI shards" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"system-proxy"},{"id":"core-2","name":"Core / shard 2","segments":"system-pac"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/codex-startup-history.mjs"

assert_desktop_case "cloud sign-in proxy scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"cloud-login-proxy"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/cloud-login-proxy.scenario.mjs" \
  "wework/e2e/desktop/modules/cloud-login-proxy-fixtures.mjs" \
  "wework/electron/src/host/cloud-http.ts" \
  "wework/electron/src/host/cloud-credential-service.ts"

assert_desktop_case "Codex notification isolation scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"codex-notification-isolation"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs"

assert_desktop_case "executor stream recovery scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"executor-stream-recovery"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/executor-stream-recovery.scenario.mjs"

assert_desktop_case "model overload recovery scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"model-overload-recovery"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/model-overload-recovery.scenario.mjs"

assert_desktop_case "transcript sync files invoke the multi-device desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"transcript-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "backend/app/services/wework_transcript_service.py" \
  "executor/src/runtime_work/native_transcript.rs" \
  "executor/src/runtime_work/handler/transcript_sync.rs" \
  "wework/dsh/transcript-sync/index.js" \
  "wework/e2e/desktop/scenarios/transcript-sync.scenario.mjs"

assert_desktop_case "Codex rollout paging invokes transcript and environment regressions" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"environment-panel-scroll"},{"id":"core-5","name":"Core / shard 5","segments":"transcript-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "executor/src/runtime_work/codex_transcript_page.rs"

assert_desktop_case "plugin detail entry retains lifecycle and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/PluginDetailView.tsx"

assert_desktop_case "plugin owner actions retain lifecycle and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/pluginOwnerActions.ts"

assert_desktop_case "plugin owner local package retains lifecycle and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/pluginOwnerLocalPackage.ts"

assert_desktop_case "plugin uninstall implementation retains lifecycle and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/pluginUninstall.ts"

for personal_plugin_dependency_path in \
  wework/src/components/plugins/findMarketplaceItemForInstalled.ts \
  wework/src/components/plugins/marketplaceCatalogMerge.ts \
  wework/src/components/plugins/plugin-dialogs/InstallPluginDialog.tsx \
  wework/src/components/plugins/plugin-dialogs/UninstallPluginDialog.tsx; do
  assert_desktop_case "Personal plugin dependency retains lifecycle and publication coverage: $personal_plugin_dependency_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
    "$personal_plugin_dependency_path"
done

assert_desktop_case "plugin inventory cache retains uninstall coordination and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication,plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/features/plugins/pluginMarketplaceCache.ts"

assert_desktop_case "plugin workspace entry retains lifecycle, auth, uninstall, and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication,plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh,plugin-background-sync-isolation"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/PluginsWorkspace.tsx"

assert_desktop_case "Core DSH plugin files select their desktop checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-dsh-plugin-management"},{"id":"core-10","name":"Core / shard 10","segments":"plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/runtime/core-dsh-plugin-manager.ts"

assert_desktop_case "plugin development files select the full desktop workflow" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/runtime/plugin-development-manager.ts"

assert_desktop_case "DSH UI plugin files select composition coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"core-dsh-ui-plugin-composition"}]}' \
  "wework/dsh/ui-applications/client.js"

assert_desktop_case "Wework plugin developer Demo selects development and composition coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"plugin-development"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"core-dsh-ui-plugin-composition"}]}' \
  "wework/dsh/plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo/client.js"

assert_desktop_case "desktop sidebar selects all owned checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"},{"id":"core-7","name":"Core / shard 7","segments":"priority-filter"},{"id":"core-8","name":"Core / shard 8","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopSidebar.tsx"

assert_desktop_case "priority section selects only its dedicated checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"priority-filter"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopSidebarPrioritySection.tsx"

assert_desktop_case "shared desktop infrastructure remains full coverage" \
  "$full_desktop_expected" \
  "wework/src/App.tsx"

