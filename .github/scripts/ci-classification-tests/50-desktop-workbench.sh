# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

for conversation_cache_path in \
  wework/src/features/workbench/runtimeConversationCache.ts \
  wework/src/features/workbench/runtimeConversationCacheStore.ts; do
  assert_desktop_case "conversation cache selects guidance, conversation and board segments" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,goal-state-sync,native-lifecycle"},{"id":"core-5","name":"Core / shard 5","segments":"transcript-sync"},{"id":"core-8","name":"Core / shard 8","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$conversation_cache_path"
done


assert_desktop_case "independent features select the union of minimum segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,streaming-conversation-switching,streaming-subagent-guidance"},{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-5","name":"Core / shard 5","segments":"transcript-sync"},{"id":"core-8","name":"Core / shard 8","segments":"goal-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/runtime-goal.ts" \
  "wework/src/components/chat/blocks/ToolBlockItem.tsx"

assert_desktop_case "runner coverage does not broaden a classified feature" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,streaming-conversation-switching,streaming-subagent-guidance"},{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-5","name":"Core / shard 5","segments":"transcript-sync"},{"id":"core-8","name":"Core / shard 8","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/task-flow.e2e.mjs" \
  "wework/src/components/chat/MessageList.tsx"

assert_desktop_case "turn lifecycle changes select supervisor, resilience and sidebar coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"resilience"},{"id":"core-6","name":"Core / shard 6","segments":"runtime-task-queue"},{"id":"core-7","name":"Core / shard 7","segments":"supervisor-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeTaskLifecycle/reducer.ts"

assert_desktop_case "runtime pane events select supervisor and conversation coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"supervisor-lifecycle"},{"id":"core-8","name":"Core / shard 8","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimePaneMessages.ts"

assert_desktop_case "temporary chat files select temporary chat and inbox approval coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"temporary-chat"},{"id":"core-2","name":"Core / shard 2","segments":"inbox-command-approval"},{"id":"core-3","name":"Core / shard 3","segments":"dots-closed-loops"},{"id":"core-10","name":"Core / shard 10","segments":"runtime-input-answer-persistence"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx"

assert_desktop_case "shared right workspace panel selects plugin development and temporary chat" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"temporary-chat"},{"id":"core-5","name":"Core / shard 5","segments":"local-harness"},{"id":"core-10","name":"Core / shard 10","segments":"plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx"

assert_desktop_case "main workbench changes select fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,temporary-chat"},{"id":"core-2","name":"Core / shard 2","segments":"window-lifecycle"},{"id":"core-3","name":"Core / shard 3","segments":"dots-closed-loops"},{"id":"core-5","name":"Core / shard 5","segments":"local-harness"},{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopWorkbenchMain.tsx"

assert_desktop_case "main workbench layout test selects fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"window-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopWorkbenchLayout.test.tsx"

assert_desktop_case "startup splash selects native startup coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"startup-fault-isolation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/host/startup-splash.ts" \
  "wework/electron/src/shell/startup-splash/styles.css"

for theme_infrastructure_path in \
  wework/electron/src/host/appearance-theme.ts \
  wework/electron/src/host/appearance-theme-contract.ts \
  wework/src/lib/code-theme.ts \
  wework/src/lib/xterm-theme.ts \
  wework/src/components/code/PierreCodeProvider.tsx; do
  assert_desktop_case "theme infrastructure selects retained rendering coverage: $theme_infrastructure_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
    "$theme_infrastructure_path"
done

for theme_foundation_path in \
  wework/src/features/appearance/presets.ts \
  wework/src/styles/globals.css \
  wework/e2e/desktop/modules/appearance-theme.mjs; do
  assert_desktop_case "theme foundations select all theme consumers: $theme_foundation_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"window-lifecycle"},{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-8","name":"Core / shard 8","segments":"collaboration-personal-issues"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-5","name":"Cloud / shard 5","segments":"window-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$theme_foundation_path"
done

assert_desktop_case "visualization theme selects gallery and rendered content coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/visualization-theme.ts"

assert_desktop_case "Wework documentation skips desktop E2E" \
  'wework_desktop_e2e=false
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/README.md"

assert_desktop_case "commit generation uses its real Git regression checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/api/commitMessage.ts"

assert_desktop_case "Issue badge changes retain board coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"},{"id":"core-8","name":"Core / shard 8","segments":"collaboration-personal-issues"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/change-requests/IssueChangeRequestBadges.tsx" \
  "wework/src/features/todo/IssueBadges.tsx"

assert_desktop_case "Smart app model module retains its existing checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"harness-app-lifecycle,harness-app-models"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/harness-app-models.mjs"

assert_desktop_case "Smart app deep-link fixtures run the lifecycle checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"harness-app-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/smart-app-marketplace-identity.mjs"

# Keep full-selection expectations independent of the classifier implementation.
full_desktop_expected="$(node "$script_dir/ci-classification-tests/expected-desktop-matrix.mjs" "$repo_root")"

for path in \
  executor/src/agents/codex.rs \
  executor/src/agents/codex/tests.rs \
  executor/src/agents/claude_code.rs \
  executor/src/agents/runtime_capabilities.rs \
  executor/src/task_runtime/mcp.rs \
  executor/src/task_runtime/mcp/context.rs; do
  assert_desktop_case "Executor path retains full coverage including deferred discovery: $path" \
    "$full_desktop_expected" "$path"
done

for path in \
  wework/electron/src/host/renderer-startup-loader.ts \
  wework/electron/src/host/renderer-startup-loader.test.ts; do
  assert_desktop_case "Startup interruption path selects its desktop regression: $path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"startup-fault-isolation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' "$path"
done


assert_desktop_case "drawing implementation retains attachment coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-attachments"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/chat/composer/DrawingCanvas.tsx" \
  "wework/src/components/chat/composer/useComposerDrawing.tsx" \
  "wework/vite/excalidrawAssets.ts"

assert_desktop_case "runner-only changes retain full coverage" \
  "$full_desktop_expected" \
  "wework/e2e/desktop/task-flow.e2e.mjs"

assert_desktop_case "native Codex catalog changes select their regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"codex-native-catalog"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "executor/crates/model-proxy/src/codex_model_catalog.rs" \
  "executor/crates/model-proxy/src/codex_model_catalog_tests.rs" \
  "wework/e2e/desktop/scenarios/codex-native-catalog.scenario.mjs" \
  "wework/e2e/desktop/scenarios/codex-catalog-context.mjs" \
  "wework/e2e/desktop/scenarios/codex-catalog-reasoning.mjs"

for reasoning_control_path in \
  packages/collaboration/src/controls/ModelSelector.tsx \
  packages/collaboration/src/controls/ModelPowerSlider.tsx \
  packages/collaboration/src/controls/model-ui.ts \
  packages/collaboration/src/controls/model-reasoning.ts \
  packages/collaboration/src/controls/model-selector-utils.ts; do
  reasoning_targets="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$reasoning_control_path")"
  if [[ "$reasoning_targets" != *"codex-native-catalog"* || \
    "$reasoning_targets" != *"model-routing"* ]]; then
    printf 'Reasoning control must select native Catalog and cloud model routing regressions: %s\n' \
      "$reasoning_control_path" >&2
    exit 1
  fi
done

assert_desktop_case "collaboration executor runtime changes retain full coverage including Issue Dispatch" \
  "$full_desktop_expected" \
  "executor/src/runtime_work/handler/claude_turns.rs"

assert_desktop_case "workbench mode changes select their desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"workbench-mode"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/workbench-mode.scenario.mjs" \
  "wework/electron/src/runtime/workbench-mode.ts" \
  "wework/src/features/workbench-mode/workbenchMode.ts"

assert_desktop_case "model settings changes select model management and routing coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"model-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/settings/ProviderEditor.tsx" \
  "wework/src/features/model-settings/providerModelConfiguration.ts"

assert_desktop_case "workbench layout changes retain full desktop coverage" \
  "$full_desktop_expected" \
  "wework/src/components/layout/DesktopWorkbenchLayout.tsx"

assert_desktop_case "external content import changes select its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"workbench-mode"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "executor/src/local/codex_home.rs" \

assert_desktop_case "native plugin installation selects lifecycle and project coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"workbench-mode"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle,plugin-composer-network-isolation"}]}' \
  "wework/src/api/local/codexPlugins.install.test.ts" \
  "wework/src/api/local/codexPluginInstallation.ts"

assert_desktop_case "native plugin API retains import, lifecycle, network isolation, and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"workbench-mode"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle,plugin-composer-network-isolation"}]}' \
  "wework/src/api/local/codexPlugins.ts"

assert_desktop_case "embedded browser files select browser coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"embedded-browser"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/src/lib/browser-url.ts"

assert_desktop_case "embedded browser scheme interception runs the agent checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"embedded-browser"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/host/embedded-browser-manager.ts" \
  "wework/e2e/desktop/scenarios/embedded-browser-agent.scenario.mjs"


assert_desktop_case "native tray files select Core and macOS restart coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"tray-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/electron/src/host/tray-manager.ts" \
  "wework/e2e/desktop/scenarios/tray-position.mjs"


assert_desktop_case "local harness files select local harness coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"claude-runtime,local-harness"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/local-harness.ts"

assert_desktop_case "Claude runtime messaging selects task and Claude coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"},{"id":"core-5","name":"Core / shard 5","segments":"claude-runtime"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"},{"id":"core-10","name":"Core / shard 10","segments":"runtime-input-answer-persistence"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create,cloud-worktree-tools"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/useWorkbenchRuntimeMessaging.ts"

assert_desktop_case "local and Cloud HTML preview files select their registered checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/workspace-panels/WorkspaceFilePreview.tsx"

assert_desktop_case "wheel input retains rendering coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/e2e/desktop-control-wheel.ts"

assert_desktop_case "Core artifact changes retain full coverage" \
  "$full_desktop_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

assert_desktop_case "Core transport changes retain full coverage" \
  "$full_desktop_expected" \
  ".github/scripts/wework-core-e2e-transport.mjs"

assert_desktop_case "Core build action changes retain full coverage" \
  "$full_desktop_expected" \
  ".github/actions/build-wework-core-e2e/action.yml"

assert_desktop_case "artifact downloader changes retain full desktop coverage" \
  "$full_desktop_expected" \
  ".github/scripts/download-actions-artifact.sh"

assert_desktop_case "skill mention files select plugin and core coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/chat/composer/ComposerMentionMenu.tsx"

assert_desktop_case "model settings select task launch and model routing coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"},{"id":"core-5","name":"Core / shard 5","segments":"model-routing"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/model-settings/localModelSettings.ts"

assert_desktop_case "composer plugin files select project plugin coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow"},{"id":"core-5","name":"Core / shard 5","segments":"model-routing"},{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-collaboration-composer-isolation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/chat/composer/PluginPickerMenu.tsx"

assert_desktop_case "automation files select lifecycle and statutory workday coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-automation"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-5","name":"Cloud / shard 5","segments":"project-automation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/automations/AutomationDetailWorkspace.tsx"

assert_desktop_case "project automation files select lifecycle and project coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-automation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/ProjectAutomationRulesSection.tsx"

assert_desktop_case "project automation E2E changes select core and cloud coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-automation"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix='"$all_cloud_matrix"'
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/project-automation.scenario.mjs"

