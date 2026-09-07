#!/usr/bin/env bash

set -euo pipefail

core_segments=(
  remote-device-onboarding
  workspace-tabs
  cloud-space-mention
  priority-filter
  external-content-import
  automation-lifecycle
  project-automation
  project-assignment-notification
  offline-local-project-space
  cloud-context-resilience
  core-dsh-plugin-management
  plugin-development
  project-ai-settings
  model-routing
  permission-modes
  workbench-mode
  computer-use
  task-status-sync
  task-board-association
  core-task-flow
  task-attachments
  window-lifecycle
  goal-lifecycle
  supervisor-lifecycle
  resilience
  runtime-task-queue
  runtime-terminal-convergence
  running-conversation-history
  codex-notification-isolation
  executor-stream-recovery
  context-compaction
  split-workbench
  release-package-startup
  component-update
  native-window-startup
  native-window-chrome
  renderer-storage
  tray-lifecycle
  conversation-state
  environment-panel-scroll
  temporary-chat
  workspace-attachments
  rendering-extensions
  change-request-status
  claude-runtime
  local-file-preview
  local-harness
  harness-apps
  embedded-browser
  browser-toolbar-actions
  browser-annotation-core
  browser-annotation-anchors
  browser-annotation-design
)
plugin_segments=(
  core-dsh-ui-plugin-composition
  plugin-lifecycle
  skill-mention-rendering
  sites-plugin-auto-install
)
formal_release_segments=(
  app-update-differential
)
cloud_worktree_segments=(
  cloud-worktree-capability
  cloud-worktree-create
  cloud-worktree-queued-cancel
  cloud-worktree-tools
  cloud-worktree-archive-restore
  cloud-worktree-device-restart
)
cloud_segments=(
  cloud-project-creation
  core-task-flow
  "${cloud_worktree_segments[@]}"
  model-routing
  embedded-browser
  telemetry-consent
  window-lifecycle
  conversation-state
  browser-multi-tabs
  resilience
  goal-lifecycle
  supervisor-lifecycle
  rendering-extensions
  workspace-attachments
  workspace-tabs
  priority-filter
  automation-lifecycle
  project-automation
  plugin-auto-update
  plugin-workspace-publication
)
# Group checkpoints by observed Cloud CI duration so every serial shard stays
# below the desktop suite's critical-path budget. Keep 15 Cloud shards so the
# 17 Core shards and Plugins job fit the observed 33-runner Linux capacity.
# shellcheck disable=SC2054 # Each element is one comma-joined shard.
cloud_shards=(
  core-task-flow
  embedded-browser,cloud-worktree-device-restart,cloud-project-creation
  goal-lifecycle,cloud-worktree-archive-restore
  rendering-extensions
  project-automation
  window-lifecycle
  priority-filter,cloud-worktree-tools
  resilience,telemetry-consent
  cloud-worktree-create,automation-lifecycle,browser-multi-tabs
  workspace-tabs,cloud-worktree-capability
  supervisor-lifecycle,conversation-state
  model-routing
  plugin-auto-update,plugin-workspace-publication
  cloud-worktree-queued-cancel
  workspace-attachments
)
# Group checkpoints by observed Core CI duration so every serial shard stays
# below the desktop suite's critical-path budget while reusing the same
# prebuilt application.
# shellcheck disable=SC2054 # Each element is one comma-joined shard.
core_shards=(
  harness-apps,browser-annotation-design
  supervisor-lifecycle,remote-device-onboarding
  temporary-chat,local-file-preview
  goal-lifecycle,embedded-browser,browser-annotation-core,permission-modes,tray-lifecycle
  conversation-state,project-ai-settings,offline-local-project-space,cloud-context-resilience,cloud-space-mention
  claude-runtime,workspace-tabs,task-attachments
  task-status-sync,task-board-association,core-task-flow,change-request-status,context-compaction
  window-lifecycle,runtime-terminal-convergence,browser-toolbar-actions,browser-annotation-anchors
  project-automation
  resilience,environment-panel-scroll
  workspace-attachments,automation-lifecycle
  project-assignment-notification,split-workbench,priority-filter
  rendering-extensions
  runtime-task-queue,release-package-startup,component-update,native-window-startup,renderer-storage,external-content-import
  local-harness,running-conversation-history,native-window-chrome
  codex-notification-isolation,core-dsh-plugin-management,plugin-development,workbench-mode,executor-stream-recovery
  model-routing,computer-use
)

validate_core_shards() {
  declare -A known_segments=()
  declare -A assigned_segments=()
  local segment
  for segment in "${core_segments[@]}"; do
    if [[ -n "${known_segments[$segment]+set}" ]]; then
      printf 'Duplicate core segment in catalog: %s\n' "$segment" >&2
      return 1
    fi
    known_segments["$segment"]=true
  done

  local shard
  for shard in "${core_shards[@]}"; do
    local shard_segments
    IFS=',' read -ra shard_segments <<< "$shard"
    for segment in "${shard_segments[@]}"; do
      if [[ -z "${known_segments[$segment]+set}" ]]; then
        printf 'Unknown core segment in core_shards: %s\n' "$segment" >&2
        return 1
      fi
      if [[ -n "${assigned_segments[$segment]+set}" ]]; then
        printf 'Duplicate core segment in core_shards: %s\n' "$segment" >&2
        return 1
      fi
      assigned_segments["$segment"]=true
    done
  done

  for segment in "${core_segments[@]}"; do
    if [[ -z "${assigned_segments[$segment]+set}" ]]; then
      printf 'Core segment missing from core_shards: %s\n' "$segment" >&2
      return 1
    fi
  done
}

validate_core_shards

validate_cloud_shards() {
  declare -A known_segments=()
  declare -A assigned_segments=()
  local segment
  for segment in "${cloud_segments[@]}"; do
    if [[ -n "${known_segments[$segment]+set}" ]]; then
      printf 'Duplicate cloud segment in catalog: %s\n' "$segment" >&2
      return 1
    fi
    known_segments["$segment"]=true
  done

  local shard
  for shard in "${cloud_shards[@]}"; do
    local shard_segments
    IFS=',' read -ra shard_segments <<< "$shard"
    for segment in "${shard_segments[@]}"; do
      if [[ -z "${known_segments[$segment]+set}" ]]; then
        printf 'Unknown cloud segment in cloud_shards: %s\n' "$segment" >&2
        return 1
      fi
      if [[ -n "${assigned_segments[$segment]+set}" ]]; then
        printf 'Duplicate cloud segment in cloud_shards: %s\n' "$segment" >&2
        return 1
      fi
      assigned_segments["$segment"]=true
    done
  done

  for segment in "${cloud_segments[@]}"; do
    if [[ -z "${assigned_segments[$segment]+set}" ]]; then
      printf 'Cloud segment missing from cloud_shards: %s\n' "$segment" >&2
      return 1
    fi
  done
}

validate_cloud_shards

validate_registered_checkpoint_coverage() {
  declare -A covered=()
  local segment
  for segment in \
    "${core_segments[@]}" \
    "${cloud_segments[@]}" \
    "${formal_release_segments[@]}"; do
    covered["$segment"]=true
  done

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repository_root
  repository_root="$(cd "$script_dir/../.." && pwd)"
  local registered
  while IFS= read -r registered; do
    [[ "$registered" == "cloud-git-worktree" || "$registered" == "browser-annotation" ]] && continue
    if [[ -z "${covered[$registered]+set}" ]]; then
      printf 'Registered desktop checkpoint missing from CI catalogs: %s\n' "$registered" >&2
      return 1
    fi
  done < <(
    cd "$repository_root"
    node --input-type=module -e \
      "import { DESKTOP_CHECKPOINTS } from './wework/e2e/desktop/checkpoints.mjs'; console.log(DESKTOP_CHECKPOINTS.join('\\n'))"
  )
}

validate_registered_checkpoint_coverage

declare -A selected=()
desktop_runner_changed=false
macos_inspector_e2e=false

select_target() {
  selected["$1"]=true
}

select_cloud_worktree_checkpoints() {
  local segment
  for segment in "${cloud_worktree_segments[@]}"; do
    select_target "cloud:$segment"
  done
}

select_all_desktop_suites() {
  select_target "core:all"
  select_target "plugins:all"
  select_target "cloud:all"
  macos_inspector_e2e=true
}

classify_wework_path() {
  local path="$1"

  case "$path" in
    wework/e2e/desktop/modules/terminal-compatibility-flows.mjs)
      select_target "cloud:core-task-flow"
      return
      ;;
    # Documentation does not change the packaged desktop application.
    wework/*.md)
      return
      ;;

    # The native startup checkpoint owns splash-window creation and teardown.
    wework/electron/src/host/startup-splash* | \
      wework/electron/src/shell/startup-splash/*)
      select_target "core:native-window-startup"
      return
      ;;

    # Browser-runner changes do not require a real desktop application.
    wework/e2e/tests/* | \
      wework/e2e/fixtures/* | \
      wework/playwright.config.ts)
      return
      ;;
    wework/e2e/desktop/task-flow.e2e.mjs)
      desktop_runner_changed=true
      return
      ;;
    wework/e2e/utils/mcp-elicitation-server.mjs)
      select_target "core:permission-modes"
      return
      ;;

    # Workbench mode owns the managed Git plugin state and settings flow.
    wework/e2e/desktop/scenarios/workbench-mode.scenario.mjs | \
      wework/electron/src/runtime/workbench-mode* | \
      wework/src/features/workbench-mode/*)
      select_target "core:workbench-mode"
      return
      ;;

    # External content import crosses the settings UI and local Executor IPC.
    wework/src/api/local/codexPlugins.ts | \
      wework/src/components/settings/ExternalContentImportDialog.tsx | \
      wework/e2e/desktop/scenarios/external-content-import.scenario.mjs)
      select_target "core:external-content-import"
      return
      ;;

    # Plugin development verifies the installed Codex guide, generated local
    # project, conditional conversation sidebar, isolated Wework, and HMR.
    wework/dsh/plugin-developer/* | \
      wework/e2e/desktop/scenarios/plugin-development.scenario.mjs | \
      wework/electron/src/runtime/plugin-development-manager* | \
      wework/resources/bundled-plugins/wework-personal/plugins/wework-plugin-developer/* | \
      wework/src/features/dsh-plugins/pluginDevelopment* | \
      wework/src/components/layout/workspace-panels/rightWorkspaceDshSidebar* | \
      wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx)
      select_target "core:plugin-development"
      if [[ "$path" == wework/dsh/plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo/* ]]; then
        select_target "plugins:core-dsh-ui-plugin-composition"
      fi
      if [[ "$path" == wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx ]]; then
        select_target "core:temporary-chat"
      fi
      return
      ;;

    # DSH UI composition verifies that Wework starts empty and gains each
    # application, route, settings page, and navigation item from plugins.
    wework/dsh/app-wework/* | \
      wework/dsh/examples/ui-extension-demo/* | \
      wework/dsh/ui-*/* | \
      wework/src/features/dsh-runtime/*)
      select_target "plugins:core-dsh-ui-plugin-composition"
      return
      ;;

    # Core DSH plugin management owns an Electron-backed desktop checkpoint.
    wework/src/components/plugins/CoreDshPluginManagementSection* | \
      wework/src/features/dsh-plugins/* | \
      wework/electron/src/runtime/core-dsh-plugin-manager*)
      select_target "core:core-dsh-plugin-management"
      select_target "core:plugin-development"
      return
      ;;
    wework/src/components/plugins/PluginManagementWorkspace*)
      select_target "core:core-dsh-plugin-management"
      select_target "core:plugin-development"
      select_target "core:project-ai-settings"
      select_target "plugins:plugin-lifecycle"
      return
      ;;

    # Plugin features have independently bootstrapped desktop segments.
    wework/src/components/plugins/* | \
      wework/src/features/plugins/* | \
      wework/src/pages/Plugin*)
      select_target "plugins:plugin-lifecycle"
      select_target "core:project-ai-settings"
      return
      ;;
    wework/src/components/sites/* | \
      wework/src/pages/SitesPage.tsx)
      select_target "plugins:sites-plugin-auto-install"
      return
      ;;
    wework/src/features/workbench/useWorkbenchSkills.ts | \
      wework/src/components/chat/composer/ComposerMentionMenu.tsx | \
      wework/src/components/chat/composer/composerMentionCandidates*)
      select_target "plugins:skill-mention-rendering"
      select_target "core:core-task-flow"
      return
      ;;

    # Cloud execution has a separate backend/executor-backed desktop suite.
    wework/src/api/cloud/* | \
      wework/src/features/cloud-connection/* | \
      wework/src/lib/cloud-authorization-window* | \
      wework/src/extensions/cloud-desktop*)
      select_target "cloud:all"
      return
      ;;

    # Window and native lifecycle behavior.
    wework/src/desktop/tray* | \
      wework/src/desktop/runtimeTaskCloseGuard* | \
      wework/src/components/layout/WindowFrameControls* | \
      wework/src/components/layout/DesktopWindowsTitlebar.tsx)
      select_target "core:window-lifecycle"
      select_target "core:tray-lifecycle"
      select_target "core:native-window-chrome"
      return
      ;;

    # Goal creation, idle continuation, and restart recovery.
    wework/src/lib/runtime-goal* | \
      wework/src/components/chat/composer/Goal* | \
      wework/src/features/workbench/runtimeTaskReminders*)
      select_target "core:goal-lifecycle"
      return
      ;;

    # The extracted priority section has its own runtime-task fixture.
    wework/src/components/layout/DesktopSidebarPrioritySection.tsx)
      select_target "core:priority-filter"
      return
      ;;
    wework/e2e/desktop/scenarios/project-automation.scenario.mjs)
      select_target "core:automation-lifecycle"
      select_target "core:project-automation"
      select_target "cloud:all"
      return
      ;;
    wework/e2e/desktop/scenarios/cloud-space-mention.scenario.mjs)
      select_target "core:cloud-space-mention"
      return
      ;;
    wework/src/features/todo/ProjectAutomation* | \
      wework/src/features/todo/projectAutomationForm* | \
      wework/src/api/projectAutomations*)
      select_target "core:automation-lifecycle"
      select_target "core:project-automation"
      return
      ;;
    wework/src/pages/AutomationsPage* | \
      wework/src/features/automations/* | \
      wework/src/types/automation.ts)
      select_target "core:automation-lifecycle"
      return
      ;;
    wework/src/api/deliveries* | \
      wework/src/api/local/localDelivery* | \
      wework/src/components/layout/useWorkbenchCloudProjectContext* | \
      wework/src/features/todo/CloudTodoWorkspace* | \
      wework/src/features/todo/TaskBoardAssociationDialog* | \
      wework/src/features/todo/WorkItemComposerGuide*)
      select_target "core:task-status-sync"
      select_target "core:task-board-association"
      if [[ "$path" == wework/src/components/layout/useWorkbenchCloudProjectContext* ]]; then
        select_target "core:cloud-context-resilience"
      fi
      return
      ;;
    wework/src/features/workbench/projectTaskTracking* | \
      wework/src/features/workbench/workbenchContextTypes*)
      select_target "core:task-status-sync"
      return
      ;;
    # The main sidebar also owns project creation, chats, and attachments.
    wework/src/components/layout/DesktopSidebar.tsx)
      select_target "core:priority-filter"
      select_target "core:core-task-flow"
      select_target "core:project-ai-settings"
      select_target "core:workspace-attachments"
      return
      ;;

    # Managed Worktree availability, routing, task projection, and settings
    # must keep both the local launch path and the real cloud lifecycle green.
    wework/src/api/executorAccess* | \
      wework/src/api/hybrid/hybridServices* | \
      wework/src/api/local/localServices* | \
      wework/src/api/runtimeWork* | \
      wework/src/components/chat/composer/PopoutWorkspaceMenu* | \
      wework/src/components/chat/composer/ProjectWorkBar* | \
      wework/src/components/chat/composer/project-work-bar-utils* | \
      wework/src/components/layout/useWorkbenchPaneEnvironment* | \
      wework/src/components/settings/WorktreesSettingsPage* | \
      wework/src/features/workbench/WorkbenchProvider* | \
      wework/src/features/workbench/projectWorkPreferences* | \
      wework/src/features/workbench/useWorkbenchRuntimeTasks* | \
      wework/src/lib/projectClassification* | \
      wework/src/lib/workspace-target* | \
      wework/src/lib/worktree-availability*)
      select_target "core:core-task-flow"
      select_target "core:workspace-attachments"
      select_cloud_worktree_checkpoints
      if [[ "$path" == wework/src/api/local/localServices* || \
        "$path" == wework/src/features/workbench/WorkbenchProvider* ]]; then
        select_target "core:project-ai-settings"
      fi
      if [[ "$path" == wework/src/features/workbench/useWorkbenchRuntimeTasks* ]]; then
        select_target "core:runtime-task-queue"
        select_target "core:task-status-sync"
      fi
      return
      ;;

    # Queueing, cancellation, retry, rate-limit, and reconnect behavior.
    wework/src/components/chat/ConversationQueuePanel* | \
      wework/src/lib/chat-error*)
      select_target "core:resilience"
      select_target "core:runtime-task-queue"
      return
      ;;
    wework/src/features/workbench/runtimeTaskLifecycle/*)
      select_target "core:supervisor-lifecycle"
      select_target "core:resilience"
      return
      ;;

    # Conversation cache changes also affect background guidance in the core
    # task flow, while the remaining files are covered by conversation state.
    wework/src/features/workbench/runtimeConversationCache*)
      select_target "core:core-task-flow"
      select_target "core:conversation-state"
      return
      ;;
    wework/src/features/workbench/runtimePaneMessages* | \
      wework/src/components/layout/useWorkbenchPaneSession* | \
      wework/src/components/chat/MessageTurnNavigation* | \
      wework/src/components/chat/ScrollableMessageArea*)
      select_target "core:conversation-state"
      if [[ "$path" == wework/src/features/workbench/runtimePaneMessages* ]]; then
        select_target "core:supervisor-lifecycle"
      fi
      return
      ;;
    wework/src/components/chat/MessageList*)
      select_target "core:conversation-state"
      select_target "core:rendering-extensions"
      return
      ;;

    # The main workbench owns the independent message scroller and fixed
    # environment panel, plus temporary-chat and project-context integration.
    wework/src/components/layout/DesktopWorkbenchMain.tsx | \
      wework/src/components/layout/DesktopWorkbenchLayout.test.tsx)
      select_target "core:environment-panel-scroll"
      if [[ "$path" == wework/src/components/layout/DesktopWorkbenchMain.tsx ]]; then
        select_target "core:temporary-chat"
        select_target "core:cloud-context-resilience"
        select_target "core:task-board-association"
      fi
      return
      ;;

    # Right-workspace temporary chats have an independently bootstrapped
    # ephemeral-thread scenario.
    wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx | \
      wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx | \
      wework/e2e/desktop/scenarios/temporary-chat.scenario.mjs)
      select_target "core:temporary-chat"
      return
      ;;

    # Cloud project-space lookup must not block the local composer.
    wework/src/features/todo/projectSpaceSelection* | \
      wework/e2e/desktop/scenarios/cloud-context-resilience.scenario.mjs)
      select_target "core:cloud-context-resilience"
      return
      ;;

    # Project/worktree creation and composer path or attachment transfer.
    wework/src/api/attachments* | \
      wework/src/api/projects* | \
      wework/src/components/projects/* | \
      wework/src/features/workbench/useWorkbenchAttachments* | \
      wework/src/components/chat/composer/AttachmentBadges* | \
      wework/src/components/chat/composer/WorktreeBranchSelector* | \
      wework/src/components/chat/composer/composerPathTransfer*)
      select_target "core:project-ai-settings"
      select_target "core:workspace-attachments"
      return
      ;;

    # The embedded browser has dedicated agent, toolbar, and annotation checkpoints.
    wework/electron/src/host/browser-runtime/* | \
      wework/electron/src/host/browser-annotation* | \
      wework/electron/src/browser-annotation* | \
      wework/src/lib/embedded-browser* | \
      wework/src/lib/browser-annotation* | \
      wework/src/lib/browser-url* | \
      wework/src/lib/browser-device-toolbar* | \
      wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel* | \
      wework/src/components/layout/workspace-panels/BrowserDeviceToolbar* | \
      wework/src/components/layout/workspace-panels/browser-annotation/* | \
      wework/src/pages/BrowserAnnotationOverlayPage* | \
      wework/src/components/layout/workspace-panels/browser-find/* | \
      wework/e2e/desktop/scenarios/embedded-browser-agent.scenario.mjs | \
      wework/e2e/desktop/scenarios/embedded-browser-annotation.scenario.mjs | \
      wework/e2e/desktop/scenarios/embedded-browser-toolbar-actions.scenario.mjs)
      select_target "core:embedded-browser"
      select_target "core:browser-toolbar-actions"
      select_target "core:browser-annotation-core"
      select_target "core:browser-annotation-anchors"
      select_target "core:browser-annotation-design"
      macos_inspector_e2e=true
      return
      ;;

    # Computer use spans the settings UI, Electron-native CUA bridge, and Codex MCP routing.
    wework/electron/src/host/computer-use-service* | \
      wework/src/components/settings/ComputerUseSettingsPage* | \
      wework/src/desktop/computerUse* | \
      wework/src/features/computer-use/* | \
      wework/e2e/desktop/scenarios/computer-use.scenario.mjs | \
      executor/src/computer_use_mcp.rs)
      select_target "core:computer-use"
      return
      ;;

    # Claude conversations cover both local and remote executor routing.
    wework/src/features/workbench/useWorkbenchRuntimeMessaging*)
      select_target "core:core-task-flow"
      select_target "core:project-ai-settings"
      select_target "core:claude-runtime"
      select_cloud_worktree_checkpoints
      return
      ;;

    # Local PTY-backed coding harnesses have dedicated desktop scenarios.
    wework/electron/src/host/local-terminal* | \
      wework/src/lib/local-harness* | \
      wework/src/lib/local-terminal* | \
      wework/src/components/layout/CentralHarnessTerminal* | \
      wework/src/components/layout/WorkbenchHarnessSelector* | \
      wework/src/components/layout/localHarnessWorkbench* | \
      wework/src/components/settings/HarnessSettingsPage* | \
      wework/e2e/desktop/scenarios/claude-runtime.scenario.mjs | \
      wework/e2e/desktop/scenarios/local-terminal.scenario.mjs)
      select_target "core:claude-runtime"
      select_target "core:local-harness"
      return
      ;;

    # Local file browsing, preview, editing, and review share one desktop
    # checkpoint so theme and loading regressions are covered together.
    wework/electron/src/host/local-workspace-files* | \
      wework/src/desktop/localWorkspaceFiles* | \
      wework/src/components/layout/workspace-panels/FileWorkspacePanel* | \
      wework/src/components/layout/workspace-panels/WorkspaceFilePreview* | \
      wework/src/components/layout/workspace-panels/WorkspaceFileTree* | \
      wework/src/components/layout/workspace-panels/WorkspaceTextFileEditor* | \
      wework/src/components/chat/FileChangesReviewPanel* | \
      wework/e2e/desktop/scenarios/local-file-preview.scenario.mjs)
      select_target "core:local-file-preview"
      return
      ;;

    # Runtime queue orchestration has an independently bootstrapped checkpoint.
    wework/e2e/desktop/scenarios/runtime-task-queue.scenario.mjs)
      select_target "core:runtime-task-queue"
      return
      ;;
    wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs)
      select_target "core:codex-notification-isolation"
      return
      ;;
    wework/e2e/desktop/scenarios/executor-stream-recovery.scenario.mjs)
      select_target "core:executor-stream-recovery"
      return
      ;;

    # Git hosting preferences and explicit device synchronization share one
    # independently bootstrapped real-Tauri checkpoint.
    wework/src/api/devices* | \
      wework/src/components/settings/GitHostingSettingsPage* | \
      wework/src/types/gitCredentials.ts | \
      wework/e2e/desktop/scenarios/change-request-status.scenario.mjs)
      select_target "core:change-request-status"
      return
      ;;

    # Assistant/tool rendering and desktop extension surfaces.
    wework/src/components/chat/blocks/* | \
      wework/src/components/chat/AttachmentImagePreview* | \
      wework/src/extensions/desktop* | \
      wework/e2e/desktop/scenarios/*)
      select_target "core:rendering-extensions"
      return
      ;;

    # The main composer, model transport, and task launch path.
    wework/src/components/chat/composer/* | \
      wework/src/features/model-settings/* | \
      wework/src/features/local-runtime/* | \
      wework/src/stream/*)
      select_target "core:core-task-flow"
      select_target "core:project-ai-settings"
      select_target "core:model-routing"
      return
      ;;

    # Shared desktop infrastructure can affect every independently registered
    # checkpoint. Keep the fallback explicit instead of guessing one segment.
    wework/*)
      select_all_desktop_suites
      return
      ;;
  esac
}

classify_path() {
  local path="$1"

  case "$path" in
    backend/app/api/ws/terminal_namespace.py | \
      backend/app/services/device/terminal_protocol.py | \
      backend/app/services/device/terminal_session_record.py | \
      backend/app/services/device/terminal_session_service.py)
      select_target "cloud:core-task-flow"
      ;;
    executor/src/local/app_ipc.rs | \
      executor/src/local/codex_home.rs | \
      executor/tests/local_app_ipc_contract.rs)
      select_target "core:external-content-import"
      ;;
    backend/app/api/endpoints/runtime_work.py | \
      backend/app/api/ws/device_namespace.py | \
      backend/app/api/ws/wework_runtime_namespace.py | \
      backend/app/schemas/device.py | \
      backend/app/schemas/runtime_work.py | \
      backend/app/services/device/runtime_route.py | \
      backend/app/services/device/runtime_rpc_service.py | \
      backend/app/services/runtime_work_service.py | \
      backend/tests/api/endpoints/test_runtime_work_api.py | \
      backend/tests/api/ws/test_device_reconnect_storm.py | \
      backend/tests/api/ws/test_wework_runtime_namespace.py | \
      backend/tests/services/test_runtime_route.py | \
      backend/tests/services/test_runtime_rpc_service.py | \
      backend/tests/services/test_runtime_work_service.py | \
      docker/device/Dockerfile)
      select_cloud_worktree_checkpoints
      ;;
    executor/* | packages/chat-core/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      select_all_desktop_suites
      ;;
    .github/workflows/wework-e2e.yml | \
      docker/wework-e2e/* | \
      .github/scripts/archive-wework-core-e2e-build.sh | \
      .github/scripts/classify-ci-changes.sh | \
      .github/scripts/classify-wework-desktop-e2e.sh | \
      .github/scripts/restore-wework-core-e2e-build.sh | \
      .github/scripts/test-classify-ci-changes.sh)
      select_all_desktop_suites
      ;;
    wework/*)
      classify_wework_path "$path"
      ;;
  esac
}

append_matrix_entry() {
  local id="$1"
  local name="$2"
  local command="$3"
  local segment="${4:-}"
  local entry

  printf -v entry \
    '{"id":"%s","name":"%s","command":"%s","segment":"%s"}' \
    "$id" "$name" "$command" "$segment"
  if [[ "$command" == "e2e:desktop" ]]; then
    core_matrix_entries+=("$entry")
  else
    other_matrix_entries+=("$entry")
  fi
}

build_matrix() {
  core_matrix_entries=()
  cloud_matrix_entries=()
  other_matrix_entries=()

  local shard_index
  for shard_index in "${!core_shards[@]}"; do
    local selected_segments=()
    local shard_segments
    IFS=',' read -ra shard_segments <<< "${core_shards[$shard_index]}"
    local segment
    for segment in "${shard_segments[@]}"; do
      if [[ "${selected[core:all]:-false}" == "true" || \
        "${selected[core:$segment]:-false}" == "true" ]]; then
        selected_segments+=("$segment")
      fi
    done
    if ((${#selected_segments[@]} > 0)); then
      local joined_segments
      joined_segments="$(IFS=,; printf '%s' "${selected_segments[*]}")"
      local entry
      printf -v entry \
        '{"id":"core-%s","name":"Core / shard %s","segments":"%s"}' \
        "$((shard_index + 1))" "$((shard_index + 1))" "$joined_segments"
      core_matrix_entries+=("$entry")
    fi
  done

  if [[ "${selected[plugins:all]:-false}" == "true" ]]; then
    append_matrix_entry plugins Plugins e2e:desktop:plugins
  else
    for segment in "${plugin_segments[@]}"; do
      if [[ "${selected[plugins:$segment]:-false}" == "true" ]]; then
        append_matrix_entry \
          "plugins-$segment" \
          "Plugins / $segment" \
          e2e:desktop:plugins \
          "$segment"
      fi
    done
  fi

  local cloud_shard_index
  for cloud_shard_index in "${!cloud_shards[@]}"; do
    local selected_cloud_segments=()
    local cloud_shard_segments
    IFS=',' read -ra cloud_shard_segments <<< "${cloud_shards[$cloud_shard_index]}"
    local cloud_segment
    for cloud_segment in "${cloud_shard_segments[@]}"; do
      if [[ "${selected[cloud:all]:-false}" == "true" || \
        "${selected[cloud:$cloud_segment]:-false}" == "true" ]]; then
        selected_cloud_segments+=("$cloud_segment")
      fi
    done
    if ((${#selected_cloud_segments[@]} > 0)); then
      local joined_cloud_segments
      joined_cloud_segments="$(IFS=,; printf '%s' "${selected_cloud_segments[*]}")"
      local entry
      printf -v entry \
        '{"id":"cloud-%s","name":"Cloud / shard %s","segments":"%s"}' \
        "$((cloud_shard_index + 1))" \
        "$((cloud_shard_index + 1))" \
        "$joined_cloud_segments"
      cloud_matrix_entries+=("$entry")
    fi
  done
}

if [[ "${1:-}" == "--all" ]]; then
  select_all_desktop_suites
elif (($# > 0)); then
  for path in "$@"; do
    classify_path "$path"
  done
else
  while IFS= read -r path; do
    [[ -n "$path" ]] && classify_path "$path"
  done
fi

if [[ "$desktop_runner_changed" == "true" && ${#selected[@]} -eq 0 ]]; then
  select_all_desktop_suites
fi

build_matrix

core_matrix_json='{"include":[]}'
other_matrix_json='{"include":[]}'
run_core=false
run_cloud=false
run_other=false
run_desktop=false
cloud_matrix_json='{"include":[]}'

if ((${#core_matrix_entries[@]} > 0)); then
  joined_core_entries="$(IFS=,; printf '%s' "${core_matrix_entries[*]}")"
  core_matrix_json="{\"include\":[$joined_core_entries]}"
  run_core=true
  run_desktop=true
fi
if ((${#other_matrix_entries[@]} > 0)); then
  joined_other_entries="$(IFS=,; printf '%s' "${other_matrix_entries[*]}")"
  other_matrix_json="{\"include\":[$joined_other_entries]}"
  run_other=true
  run_desktop=true
fi
if ((${#cloud_matrix_entries[@]} > 0)); then
  joined_cloud_entries="$(IFS=,; printf '%s' "${cloud_matrix_entries[*]}")"
  cloud_matrix_json="{\"include\":[$joined_cloud_entries]}"
  run_cloud=true
  run_desktop=true
fi

output_file="${GITHUB_OUTPUT:-/dev/stdout}"
{
  printf 'wework_desktop_e2e=%s\n' "$run_desktop"
  printf 'wework_desktop_core_e2e=%s\n' "$run_core"
  printf 'wework_desktop_core_e2e_matrix=%s\n' "$core_matrix_json"
  printf 'wework_desktop_cloud_e2e=%s\n' "$run_cloud"
  printf 'wework_desktop_cloud_e2e_matrix=%s\n' "$cloud_matrix_json"
  printf 'wework_desktop_other_e2e=%s\n' "$run_other"
  printf 'wework_desktop_other_e2e_matrix=%s\n' "$other_matrix_json"
  printf 'wework_desktop_macos_inspector_e2e=%s\n' "$macos_inspector_e2e"
} >> "$output_file"
