# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

assert_desktop_case "runtime reminder changes retain goal and stand-in notification coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in-notifications"},{"id":"core-8","name":"Core / shard 8","segments":"goal-lifecycle,stand-in-cloud,stand-in-assignment-notifications"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeTaskReminders.ts"

assert_desktop_case "stand-in inherited permissions scenario is covered by CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"stand-in-permissions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/stand-in-permissions.scenario.mjs"

for stand_in_path in \
  "wework/src/features/todo/StandInOverviewPage.tsx" \
  "wework/e2e/desktop/scenarios/stand-in-workspace.scenario.mjs" \
  "wework/src/features/todo/StandInComposer.tsx" \
  "wework/src/features/todo/StandInSettingsPage.tsx" \
  "wework/src/features/todo/useStandInModels.ts" \
  "wework/src/features/todo/IssueStandInControl.tsx"
do
  assert_desktop_case "stand-in workspace changes select all stand-in checkpoints: $stand_in_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in,stand-in-identities,stand-in-connections,stand-in-mcp,stand-in-cli,stand-in-plugin-bridge,stand-in-alternate-source,stand-in-action-confirmation,stand-in-email,stand-in-list-confirmation,stand-in-profile,stand-in-telemetry,stand-in-controls,stand-in-project-enable,stand-in-git"},{"id":"core-5","name":"Core / shard 5","segments":"stand-in-personal-task"},{"id":"core-7","name":"Core / shard 7","segments":"stand-in-permissions,stand-in-workspace"},{"id":"core-8","name":"Core / shard 8","segments":"stand-in-cloud,stand-in-assignment-notifications"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$stand_in_path"
done

for stand_in_work_path in \
  "wework/e2e/desktop/scenarios/stand-in-alternate-source.scenario.mjs" \
  "wework/src/features/todo/StandInWorkList.tsx" \
  "wework/src/features/todo/StandInWorkConfirmation.tsx"; do
  assert_desktop_case "stand-in work surfaces retain workspace and conversation coverage" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in,stand-in-identities,stand-in-connections,stand-in-mcp,stand-in-cli,stand-in-plugin-bridge,stand-in-alternate-source,stand-in-action-confirmation,stand-in-email,stand-in-list-confirmation,stand-in-profile,stand-in-telemetry,stand-in-git"},{"id":"core-7","name":"Core / shard 7","segments":"stand-in-workspace"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$stand_in_work_path"
done

assert_desktop_case "stand-in conversation retains workspace coverage and delegated delivery loops" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"stand-in,stand-in-identities,stand-in-connections,stand-in-mcp,stand-in-cli,stand-in-plugin-bridge,stand-in-alternate-source,stand-in-action-confirmation,stand-in-email,stand-in-list-confirmation,stand-in-profile,dots-closed-loops,stand-in-telemetry,stand-in-git"},{"id":"core-7","name":"Core / shard 7","segments":"stand-in-workspace"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/StandInConversation.tsx"

assert_desktop_case "shared collaboration package selects its desktop checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"collaboration-remote-group-coordinate"},{"id":"core-2","name":"Core / shard 2","segments":"project-assignment-notification,collaboration-runtime-reconciliation,project-member-overrides,collaboration-issue-comment-attachments,collaboration-issue-attachment-preview,collaboration-group-onboarding"},{"id":"core-3","name":"Core / shard 3","segments":"stand-in,stand-in-identities,stand-in-connections,stand-in-mcp,stand-in-cli,stand-in-plugin-bridge,stand-in-alternate-source,stand-in-action-confirmation,stand-in-email,stand-in-list-confirmation,stand-in-profile,stand-in-telemetry,collaboration-human-round-resume,stand-in-controls,stand-in-project-enable,board-transcript-followup,stand-in-git"},{"id":"core-4","name":"Core / shard 4","segments":"collaboration-board-move-recovery,collaboration-home-preload,collaboration-local-group-coordinate,collaboration-issue-comment-mention"},{"id":"core-5","name":"Core / shard 5","segments":"collaboration-local-agent-dispatch,collaboration-worktree-policy,stand-in-personal-task"},{"id":"core-6","name":"Core / shard 6","segments":"collaboration-issue-archive,collaboration-milestones"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-remote-agent-dispatch,collaboration-issue-assignment-activity,stand-in-permissions,stand-in-workspace"},{"id":"core-8","name":"Core / shard 8","segments":"collaboration-issue-comment-notification,collaboration-remote-group-planning-details,stand-in-cloud,stand-in-assignment-notifications,collaboration-local-group-cancellation,collaboration-first-use,collaboration-board-sorting,collaboration-board-backlog"},{"id":"core-10","name":"Core / shard 10","segments":"collaboration-shared-core,collaboration-parent-board"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "packages/collaboration/src/CollaborationApp.tsx"

for consent_path in \
  "packages/collaboration/src/conversation/McpUrlAuthorizationCard.tsx" \
  "packages/collaboration/src/conversation/RequestUserInputCard.tsx" \
  "wework/src/components/chat/RequestUserInputCard.tsx" \
  "wework/scripts/mcp-elicitation-server.test.mjs"; do
  consent_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$consent_path")"
  if [[ "$consent_output" != *permission-modes* ]]; then
    printf 'MCP consent path did not select permission-modes: %s\n' "$consent_path" >&2
    exit 1
  fi
done

personal_board_expected='wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"collaboration-shared-core"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}'
for personal_board_path in \
  "wework/e2e/desktop/scenarios/collaboration-shared-core.scenario.mjs" \
  "wework/e2e/desktop/modules/collaboration-board-personal-view.mjs" \
  "wework/e2e/desktop/modules/collaboration-board-field-drag.mjs" \
  "wework/e2e/desktop/modules/collaboration-board-preferences.mjs" \
  "wework/e2e/desktop/modules/collaboration-board-tag-drag.mjs" \
  "wework/e2e/desktop/modules/project-only-navigation.mjs"; do
  assert_desktop_case "Personal Issue board regression selects its checkpoint: $personal_board_path" \
    "$personal_board_expected" "$personal_board_path"
done

assert_desktop_case "Lane sorting scenario is invoked by its core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"collaboration-board-sorting"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-board-sorting.scenario.mjs"

assert_desktop_case "Move recovery scenario is invoked by its core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"collaboration-board-move-recovery"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-board-move-recovery.scenario.mjs"

assert_desktop_case "Issue archive scenario selects its own checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"collaboration-issue-archive"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-issue-archive.scenario.mjs"

assert_desktop_case "Issue task discovery scenario is invoked by its core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-issue-task-discovery"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-issue-task-discovery.scenario.mjs"

assert_desktop_case "App queue identity regression is invoked by its core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-app-queue-identity"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-app-queue-identity.scenario.mjs"

assert_desktop_case "issue comment mention scenario selects its own checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"collaboration-issue-comment-mention"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-issue-comment-mention.scenario.mjs"

for assignment_activity_path in \
  "wework/e2e/desktop/scenarios/collaboration-issue-assignment-activity.scenario.mjs" \
  "wework/src/features/todo/IssueAssignmentEvent.tsx" \
  "wework/src/features/todo/assignmentHistoryLabels.ts" \
  "wework/src/features/todo/issueActivityTimeline.ts" \
  "wework/src/features/todo/useIssueActivityHistory.ts"; do
  assert_desktop_case "assignment activity regression is invoked by core CI: $assignment_activity_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-issue-assignment-activity"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$assignment_activity_path"
done

assert_desktop_case "local assignment adapter changes include activity persistence coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-status-sync"},{"id":"core-3","name":"Core / shard 3","segments":"collaboration-human-round-resume"},{"id":"core-4","name":"Core / shard 4","segments":"task-board-bulk-actions,collaboration-local-group-coordinate"},{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-issue-assignment-activity"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/api/local/localDelivery.ts"
assert_desktop_case "Issue comment image scenario is invoked by its core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-issue-comment-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-issue-comment-attachments.scenario.mjs"

assert_desktop_case "Issue attachment preview scenario selects its own checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-issue-attachment-preview"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-issue-attachment-preview.scenario.mjs"

assert_desktop_case "Clipboard history image conversion selects core and macOS coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"clipboard-history-image"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/src/lib/clipboard-images.ts"

for preview_path in \
  "backend/app/api/endpoints/adapter/attachments.py" \
  "backend/tests/api/endpoints/adapter/test_attachment_download_policy_routes.py" \
  "backend/tests/api/endpoints/adapter/test_content_disposition.py" \
  "backend/app/api/endpoints/deliveries.py" \
  "backend/tests/api/test_deliveries_api.py"
do
  assert_desktop_case "Attachment content changes select the real image preview checkpoint: $preview_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-issue-attachment-preview"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$preview_path"
done

assert_desktop_case "Cloud project file content selects preview and permission checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-member-overrides,collaboration-issue-attachment-preview"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "backend/app/api/endpoints/cloud_projects.py"

cloud_file_tests_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" \
  "backend/tests/api/test_cloud_projects_api.py")"
if [[ "$cloud_file_tests_output" != *collaboration-issue-attachment-preview* ]]; then
  printf 'Cloud file API tests did not select the real image preview checkpoint\n' >&2
  exit 1
fi

for reconciliation_fixture in \
  wework/e2e/desktop/scenarios/collaboration-runtime-reconciliation.scenario.mjs \
  wework/e2e/desktop/modules/database-lock.mjs \
  wework/e2e/desktop/modules/runtime-event-proxy.mjs \
  wework/e2e/desktop/modules/runtime-reconciliation-model.mjs \
  wework/scripts/runtime-event-proxy.test.mjs \
  wework/scripts/runtime-reconciliation-model.test.mjs; do
  assert_desktop_case "Runtime reconciliation fixture selects its core CI shard: $reconciliation_fixture" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-runtime-reconciliation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$reconciliation_fixture"
done

for reconciliation_path in \
  backend/app/api/ws/device_namespace.py \
  backend/app/api/endpoints/loop_item_executions.py \
  backend/app/schemas/runtime_execution_snapshot.py \
  backend/app/services/project_chat/execution_snapshot.py \
  backend/app/services/loop_item_executions/service.py \
  backend/tests/api/ws/test_device_runtime_content_reconciliation.py \
  backend/tests/services/test_loop_item_executions.py \
  backend/tests/services/test_project_chat_execution_snapshot.py \
  packages/collaboration/src/issue-detail/RuntimeExecutionConversation.tsx \
  packages/collaboration/src/http-api/createSharedWorkspaceHttpApi.ts; do
  reconciliation_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$reconciliation_path")"
  if [[ "$reconciliation_output" != *collaboration-runtime-reconciliation* ]]; then
    printf 'Runtime reconciliation path did not select its regression: %s\n%s\n' \
      "$reconciliation_path" "$reconciliation_output" >&2
    exit 1
  fi
done

for runtime_input_path in \
  "wework/e2e/desktop/scenarios/runtime-input-answer-persistence.scenario.mjs" \
  "wework/e2e/desktop/scenarios/consecutive-questions.scenario.mjs" \
  "wework/e2e/desktop/modules/interaction-draft-windows.mjs" \
  "wework/e2e/desktop/modules/native-reply-recovery.mjs" \
  "wework/e2e/desktop/modules/pending-interactions-tab.mjs"; do
  assert_desktop_case "Runtime input answer scenario dependency selects only its checkpoint: $runtime_input_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"runtime-input-answer-persistence"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$runtime_input_path"
done

for pending_answer_path in \
  "wework/src/features/notifications/RuntimeInteractionsProvider.tsx" \
  "wework/src/features/notifications/RuntimeInteractionsProvider.liveSettlement.test.tsx" \
  "wework/src/features/notifications/runtimeInteractions.ts" \
  "wework/src/features/notifications/useRuntimeInteractionSettlements.ts" \
  "wework/src/features/notifications/useInteractionDrafts.ts" \
  "wework/src/features/notifications/useNativeInteractionReplies.ts" \
  "wework/src/features/notifications/interactionArchive.ts" \
  "wework/src/features/notifications/interactionStorage.ts" \
  "wework/src/features/notifications/RuntimeInteractionsPage.tsx" \
  "wework/src/features/notifications/InteractionDraftRecovery.tsx"; do
  pending_answer_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$pending_answer_path")"
  if [[ "$pending_answer_output" != *runtime-input-answer-persistence* ]]; then
    printf 'Pending answer regression missing from CI selection: %s\n' "$pending_answer_path" >&2
    exit 1
  fi
done

assert_desktop_case "collaboration execution environment changes select onboarding and lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"collaboration-remote-group-coordinate"},{"id":"core-2","name":"Core / shard 2","segments":"project-assignment-notification,collaboration-runtime-reconciliation,project-member-overrides,collaboration-group-onboarding"},{"id":"core-3","name":"Core / shard 3","segments":"stand-in,stand-in-identities,stand-in-connections,stand-in-mcp,stand-in-cli,stand-in-plugin-bridge,stand-in-alternate-source,stand-in-action-confirmation,stand-in-email,stand-in-list-confirmation,stand-in-profile,stand-in-telemetry,collaboration-human-round-resume,stand-in-controls,stand-in-project-enable,stand-in-git"},{"id":"core-4","name":"Core / shard 4","segments":"collaboration-local-group-coordinate"},{"id":"core-5","name":"Core / shard 5","segments":"collaboration-local-agent-dispatch,collaboration-worktree-policy,stand-in-personal-task"},{"id":"core-6","name":"Core / shard 6","segments":"remote-device-onboarding,collaboration-issue-archive,collaboration-milestones,collaboration-deliveries,collaboration-delivery-editing"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-remote-agent-dispatch,stand-in-permissions,stand-in-workspace"},{"id":"core-8","name":"Core / shard 8","segments":"collaboration-remote-group-planning-details,stand-in-cloud,stand-in-assignment-notifications,collaboration-local-group-cancellation,collaboration-first-use"},{"id":"core-10","name":"Core / shard 10","segments":"collaboration-shared-core,collaboration-template-agents,collaboration-template-app-device-routing"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-device-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "packages/collaboration/src/platform/WorkspaceResourceConfiguration.tsx" \
  "packages/collaboration/src/project-agent-config/ProjectAgentConfiguration.tsx" \
  "packages/collaboration/src/http-api/createSharedWorkspaceHttpApi.ts" \
  "packages/collaboration/src/ports/SharedWorkspaceApi.ts" \
  "packages/collaboration/src/dto-mappers/workspaceDtoMappers.ts"

for template_agent_path in \
  executor/src/task_runtime/store.rs \
  packages/collaboration/src/project-agent-config/ProjectAgentConfiguration.tsx; do
  template_agent_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$template_agent_path")"
  if [[ "$template_agent_output" != *collaboration-template-agents* ]]; then
    printf 'Template agent execution coverage missing for %s\n' "$template_agent_path" >&2
    exit 1
  fi
done
for app_device_routing_path in \
  wework/src/api/agentRoutingCatalog.ts \
  wework/src/features/collaboration/WeworkProjectAgentConfigurationHost.tsx \
  packages/collaboration/src/agent-form/runnerRouting.ts; do
  app_device_routing_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$app_device_routing_path")"
  if [[ "$app_device_routing_output" != *collaboration-template-app-device-routing* ]]; then
    printf 'APP device template routing coverage missing for %s\n' "$app_device_routing_path" >&2
    exit 1
  fi
done
template_unrelated_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" packages/collaboration/src/http-api/createSharedWorkspaceHttpApi.ts)"
if [[ "$template_unrelated_output" == *collaboration-template-agents* ]]; then
  printf 'Template agent execution coverage widened unrelated dispatch paths\n' >&2
  exit 1
fi

for personal_version_path in \
  wework/e2e/desktop/scenarios/plugin-installation.scenario.mjs \
  wework/scripts/plugin-personal-runtime.test.mjs \
  wework/e2e/desktop/modules/plugin-personal-version-flow.mjs \
  wework/e2e/desktop/modules/plugin-personal-recipient-install.mjs \
  wework/e2e/desktop/modules/plugin-personal-uninstall-flow.mjs; do
  assert_desktop_case "Personal plugin versions retain cloud publication coverage: $personal_version_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$personal_version_path"
done

for personal_version_implementation_path in \
  wework/src/components/plugins/PluginVersionSubmitDrawer.tsx \
  wework/src/components/plugins/pluginVersionSubmission.ts \
  wework/src/components/plugins/hooks/usePluginDetailSelection.ts \
  wework/src/components/plugins/hooks/usePluginDetailSelection.test.ts \
  wework/src/components/plugins/hooks/usePluginVersionSubmission.tsx; do
  assert_desktop_case "Personal plugin version implementation retains lifecycle and publication coverage: $personal_version_implementation_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
    "$personal_version_implementation_path"
done

assert_desktop_case "Creator resources select desktop and cloud delivery" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-marketplace-lifecycle"}]}' \
  "sdk/plugin-creator/SKILL.md"
for terminal_path in \
  wework/e2e/desktop/modules/terminal-compatibility-flows.mjs \
  backend/app/api/ws/terminal_namespace.py \
  backend/app/services/device/terminal_protocol.py \
  backend/app/services/device/terminal_session_record.py \
  backend/app/services/device/terminal_session_service.py; do
  assert_desktop_case "terminal compatibility is included in cloud core-task-flow: $terminal_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$terminal_path"
done
