# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

for conversation_cache_path in \
  wework/src/features/workbench/runtimeConversationCache.ts \
  wework/src/features/workbench/runtimeConversationCacheStore.ts; do
  assert_desktop_case "conversation cache selects guidance, conversation and board segments" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"core-task-flow,goal-state-sync,native-lifecycle"},{"id":"core-3","name":"Core / shard 3","segments":"board-transcript-followup"},{"id":"core-8","name":"Core / shard 8","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$conversation_cache_path"
done

assert_desktop_case "split interaction latency uses an independent runner" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"split-workbench"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/split-workbench.scenario.mjs"

assert_desktop_case "independent features select the union of minimum segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"streaming-message-order,streaming-conversation-switching,rendering-extensions,streaming-subagents,streaming-timers"},{"id":"core-2","name":"Core / shard 2","segments":"streaming-scroll,streaming-tools"},{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-8","name":"Core / shard 8","segments":"goal-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/runtime-goal.ts" \
  "wework/src/components/chat/blocks/ToolBlockItem.tsx"

assert_desktop_case "runner coverage does not broaden a classified feature" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"streaming-message-order,streaming-conversation-switching,rendering-extensions,streaming-subagents,streaming-timers"},{"id":"core-2","name":"Core / shard 2","segments":"streaming-scroll,streaming-tools"},{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-8","name":"Core / shard 8","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/task-flow.e2e.mjs" \
  "wework/src/components/chat/MessageList.tsx"

assert_desktop_case "turn lifecycle changes select supervisor, resilience and sidebar coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"resilience"},{"id":"core-6","name":"Core / shard 6","segments":"running-sidebar-state"},{"id":"core-7","name":"Core / shard 7","segments":"supervisor-lifecycle"}]}
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

assert_desktop_case "temporary chat files select temporary chat coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"temporary-chat"},{"id":"core-3","name":"Core / shard 3","segments":"dots-closed-loops"},{"id":"core-10","name":"Core / shard 10","segments":"runtime-input-answer-persistence"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx"

assert_desktop_case "shared right workspace panel selects plugin development and temporary chat" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"temporary-chat"},{"id":"core-8","name":"Core / shard 8","segments":"background-terminals"},{"id":"core-10","name":"Core / shard 10","segments":"plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx"

assert_desktop_case "main workbench changes select fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"temporary-chat"},{"id":"core-3","name":"Core / shard 3","segments":"dots-closed-loops"},{"id":"core-4","name":"Core / shard 4","segments":"environment-panel-scroll"},{"id":"core-5","name":"Core / shard 5","segments":"feedback-entry"},{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"},{"id":"core-8","name":"Core / shard 8","segments":"background-terminals,cloud-context-resilience"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopWorkbenchMain.tsx"

assert_desktop_case "main workbench layout test selects fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"environment-panel-scroll"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopWorkbenchLayout.test.tsx"

assert_desktop_case "startup splash selects native startup coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"native-window-startup"}]}
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
  assert_desktop_case "theme infrastructure selects its theme checkpoint: $theme_infrastructure_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"appearance-themes"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$theme_infrastructure_path"
done

for theme_foundation_path in \
  wework/src/features/appearance/presets.ts \
  wework/src/styles/globals.css \
  wework/e2e/desktop/modules/appearance-theme.mjs; do
  assert_desktop_case "theme foundations select all theme consumers: $theme_foundation_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-5","name":"Core / shard 5","segments":"application-menu"},{"id":"core-6","name":"Core / shard 6","segments":"local-file-preview,appearance-themes,office-file-preview"},{"id":"core-8","name":"Core / shard 8","segments":"background-terminals,collaboration-first-use"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$theme_foundation_path"
done

assert_desktop_case "visualization theme selects gallery and rendered content coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"streaming-content"},{"id":"core-6","name":"Core / shard 6","segments":"appearance-themes"}]}
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
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"git-commit-generation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/api/commitMessage.ts"

assert_desktop_case "Issue badges run their persistence regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-issue-badges"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/change-requests/IssueChangeRequestBadges.tsx" \
  "wework/src/features/todo/IssueBadges.tsx" \
  "wework/e2e/desktop/scenarios/collaboration-issue-badges.scenario.mjs"

assert_desktop_case "Harness app changes run every harness app checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"harness-app-lifecycle,harness-app-models"},{"id":"core-7","name":"Core / shard 7","segments":"harness-app-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/harness-apps.scenario.mjs" \
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
  wework/electron/src/host/renderer-startup-loader.test.ts \
  wework/electron/src/host/e2e-startup-network-fault.ts \
  wework/e2e/desktop/scenarios/startup-network-change.scenario.mjs; do
  assert_desktop_case "Startup interruption path selects its desktop regression: $path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"startup-network-change"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' "$path"
done

assert_desktop_case "latest conversation history runs its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"latest-conversation-history"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/latest-conversation-history.scenario.mjs"

assert_desktop_case "drawing implementation and scenario select their desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"drawing-attachment"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/chat/composer/DrawingCanvas.tsx" \
  "wework/src/components/chat/composer/useComposerDrawing.tsx" \
  "wework/vite/excalidrawAssets.ts" \
  "wework/e2e/desktop/scenarios/drawing-attachment.scenario.mjs"

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
    "$reasoning_targets" != *"cloud-model-presets"* ]]; then
    printf 'Reasoning control must select native Catalog and cloud preset regressions: %s\n' \
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

assert_desktop_case "Codex account login scenario selects its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"codex-account-login"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/codex-account-login.scenario.mjs"

assert_desktop_case "model settings changes select model management and account coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"codex-account-login"},{"id":"core-2","name":"Core / shard 2","segments":"model-settings"},{"id":"core-5","name":"Core / shard 5","segments":"model-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/model-settings.scenario.mjs" \
  "wework/src/components/settings/ProviderEditor.tsx" \
  "wework/src/features/model-settings/providerModelConfiguration.ts"

assert_desktop_case "workbench layout changes retain full desktop coverage" \
  "$full_desktop_expected" \
  "wework/src/components/layout/DesktopWorkbenchLayout.tsx"

assert_desktop_case "external content import changes select its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"external-content-import"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "executor/src/local/codex_home.rs" \
  "wework/e2e/desktop/scenarios/external-content-import.scenario.mjs"

assert_desktop_case "native plugin installation selects lifecycle and project coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings,external-content-import"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle,plugin-composer-network-isolation"}]}' \
  "wework/src/api/local/codexPlugins.install.test.ts" \
  "wework/src/api/local/codexPluginInstallation.ts"

assert_desktop_case "native plugin API retains import, lifecycle, network isolation, and publication coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings,external-content-import"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle,plugin-composer-network-isolation"}]}' \
  "wework/src/api/local/codexPlugins.ts"

assert_desktop_case "embedded browser files select browser coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"embedded-browser,browser-annotation-design"},{"id":"core-4","name":"Core / shard 4","segments":"browser-annotation-anchors"},{"id":"core-5","name":"Core / shard 5","segments":"browser-annotation-core"},{"id":"core-6","name":"Core / shard 6","segments":"browser-toolbar-actions"}]}
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

assert_desktop_case "browser toolbar scenario is invoked by Core and macOS CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"embedded-browser,browser-annotation-design"},{"id":"core-4","name":"Core / shard 4","segments":"browser-annotation-anchors"},{"id":"core-5","name":"Core / shard 5","segments":"browser-annotation-core"},{"id":"core-6","name":"Core / shard 6","segments":"browser-toolbar-actions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/e2e/desktop/scenarios/embedded-browser-toolbar-actions.scenario.mjs"

assert_desktop_case "native tray files select Core and macOS restart coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"tray-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/electron/src/host/tray-manager.ts" \
  "wework/e2e/desktop/scenarios/tray-position.mjs"

assert_desktop_case "background terminal files select their registered Core checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"background-terminals"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/background-terminals.scenario.mjs" \
  "wework/src/components/layout/BackgroundTerminalsSummary.tsx"

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
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"local-file-preview,office-file-preview"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-4","name":"Cloud / shard 4","segments":"rendering-extensions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/WorkspaceFilePreview.tsx"

assert_desktop_case "Office fixtures and wheel input select their registered checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"office-file-preview"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/office-file-preview.scenario.mjs" \
  "wework/e2e/desktop/modules/office-preview-fixtures.mjs" \
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
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"skill-mention-rendering"}]}' \
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
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-composer-long-list"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/chat/composer/PluginPickerMenu.tsx"

assert_desktop_case "automation files select only automation lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"automation-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/automations/AutomationDetailWorkspace.tsx"

assert_desktop_case "project automation files select lifecycle and project coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-automation"},{"id":"core-3","name":"Core / shard 3","segments":"automation-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/ProjectAutomationRulesSection.tsx"

assert_desktop_case "project automation E2E changes select core and cloud coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-automation"},{"id":"core-3","name":"Core / shard 3","segments":"automation-lifecycle"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-runtime-path-recovery,plugin-legacy-upgrade,plugin-uninstall-lost-response,embedded-browser,cloud-project-creation,automation-lifecycle,browser-multi-tabs"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow,goal-lifecycle,supervisor-lifecycle,priority-filter,cloud-worktree-create,plugin-toggle-persistence,cloud-worktree-tools,cloud-model-presets,responses-tool-compatibility"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-auto-update,resilience,workspace-tabs,plugin-workspace-publication,plugin-write-coordination,workspace-attachments,cloud-device-lifecycle,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"model-routing,conversation-state,plugin-uninstall-unknown-result,cloud-model-recovery,rendering-extensions,telemetry-consent,plugin-registration-coordination,stand-in-cloud-device"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"window-lifecycle,plugin-uninstall-reinstall-race,project-automation,cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel,task-model-deletion"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-composer-long-list,plugin-collaboration-composer-isolation,plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/project-automation.scenario.mjs"

