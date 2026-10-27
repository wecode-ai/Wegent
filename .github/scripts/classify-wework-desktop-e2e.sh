#!/usr/bin/env bash

set -euo pipefail

core_segments=(
  voice-input
  remote-device-onboarding
  workspace-tabs
  notification-tab-navigation
  collaboration-shared-core
  collaboration-deliveries
  collaboration-issue-task-discovery
  collaboration-app-queue-identity
  collaboration-runtime-reconciliation
  collaboration-issue-archive
  collaboration-board-sorting
  collaboration-board-move-recovery
  collaboration-first-use
  collaboration-worktree-policy
  collaboration-group-onboarding
  collaboration-local-agent-dispatch
  stand-in
  stand-in-identities
  stand-in-connections
  stand-in-mcp
  stand-in-cli
  stand-in-plugin-bridge
  stand-in-action-confirmation
  stand-in-list-confirmation
  stand-in-profile
  stand-in-telemetry
  stand-in-workspace
  stand-in-controls
  stand-in-project-enable
  stand-in-cloud
  stand-in-notifications

  stand-in-assignment-notifications
  stand-in-personal-task
  stand-in-permissions
  collaboration-remote-agent-dispatch
  collaboration-local-group-coordinate
  collaboration-remote-group-coordinate
  collaboration-remote-group-planning-details
  collaboration-human-round-resume
  collaboration-local-group-cancellation
  collaboration-issue-comment-mention
  collaboration-issue-assignment-activity
  collaboration-issue-comment-attachments
  collaboration-issue-attachment-preview
  collaboration-issue-comment-notification
  collaboration-issue-mcp-comments
  cloud-space-mention
  priority-filter
  external-content-import
  automation-lifecycle
  project-automation
  project-assignment-notification
  project-member-overrides
  offline-local-project-space
  cloud-context-resilience
  cloud-login-proxy
  core-dsh-plugin-management
  plugin-development
  project-ai-settings
  model-routing
  fork-provider-preservation
  codex-account-login
  permission-modes
  runtime-input-answer-persistence
  workbench-mode
  computer-use
  task-status-sync
  task-board-association
  task-board-bulk-actions
  core-task-flow
  task-attachments
  drawing-attachment
  window-lifecycle
  goal-lifecycle
  goal-state-sync
  supervisor-lifecycle
  resilience
  runtime-task-queue
  codex-invalid-launch-cwd
  running-conversation-history
  latest-conversation-history
  running-plan-history
  running-sidebar-state
  codex-notification-isolation
  executor-stream-recovery
  model-overload-recovery
  transcript-sync
  context-compaction
  split-workbench
  release-package-startup
  component-update
  native-window-startup
  renderer-crash-recovery
  native-window-chrome
  renderer-storage
  application-menu
  tray-lifecycle
  conversation-state
  send-key-preference
  reply-predictions
  archived-worktree-cleanup
  reply-prediction-auth
  model-settings
  codex-native-catalog
  system-proxy
  system-pac
  environment-panel-scroll
  temporary-chat
  workspace-attachments
  rendering-extensions
  streaming-content
  streaming-tools
  streaming-timers
  streaming-scroll
  streaming-message-order
  streaming-conversation-switching
  streaming-subagents
  background-terminals
  collaboration-issue-badges
  change-request-status
  git-commit-generation
  claude-runtime
  local-file-preview
  office-file-preview
  local-harness
  harness-app-development
  harness-app-lifecycle
  embedded-browser
  browser-toolbar-actions
  browser-annotation-core
  browser-annotation-anchors
  browser-annotation-design
  dsh-owner-capture
)
plugin_segments=(
  core-dsh-ui-plugin-composition
  plugin-marketplace-lifecycle
  plugin-lifecycle
  plugin-composer-network-isolation
  skill-mention-rendering
  sites-plugin-auto-install
)
formal_release_segments=(
  app-update-full
)
cloud_worktree_segments=(
  cloud-worktree-capability
  cloud-worktree-create
  cloud-worktree-queued-cancel
  cloud-worktree-tools
  cloud-worktree-archive-restore
)
cloud_segments=(
  cloud-model-recovery
  task-model-deletion
  cloud-model-presets
  cloud-project-creation
  cloud-device-lifecycle
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
  plugin-account-auth-password
  plugin-account-auth-transfer
  plugin-account-auth-oauth
  plugin-account-auth-dws
  plugin-account-auth-conversation
  plugin-account-auth-github
  plugin-uninstall-lost-response
  plugin-uninstall-unknown-result
  plugin-uninstall-restart-recovery
  plugin-uninstall-reinstall-race
  plugin-write-coordination
  plugin-registration-coordination
  plugin-account-auth-coordination
  plugin-composer-long-list
  plugin-collaboration-composer-isolation
  plugin-runtime-path-recovery
  plugin-runtime-route-refresh
  plugin-background-sync-isolation
  plugin-periodic-reconcile
  plugin-workspace-publication
  plugin-toggle-persistence
)
# Balance measured checkpoint durations across four workers, longest first.
# Run 39930854745: five ordinary Cloud shards predict 291-339 seconds.
# Keep account auth separate from the plugin sync and 24-plugin composer fixtures.
# shellcheck disable=SC2054 # Each element is one comma-joined shard.
cloud_shards=(
  plugin-uninstall-restart-recovery,plugin-runtime-path-recovery,plugin-uninstall-lost-response,embedded-browser,cloud-project-creation,automation-lifecycle,browser-multi-tabs
  core-task-flow,goal-lifecycle,supervisor-lifecycle,priority-filter,cloud-worktree-create,plugin-toggle-persistence,cloud-worktree-tools,cloud-model-presets
  plugin-auto-update,resilience,workspace-tabs,plugin-workspace-publication,plugin-write-coordination,workspace-attachments,cloud-device-lifecycle,plugin-account-auth-coordination
  model-routing,conversation-state,plugin-uninstall-unknown-result,cloud-model-recovery,rendering-extensions,telemetry-consent,plugin-registration-coordination
  window-lifecycle,plugin-uninstall-reinstall-race,project-automation,cloud-worktree-archive-restore,cloud-worktree-capability,cloud-worktree-queued-cancel,task-model-deletion
  plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth
  plugin-composer-long-list,plugin-collaboration-composer-isolation,plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile
  plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github
)
# Run 39930854745: eight ordinary Core shards predict 323-332 seconds.
# Co-locate CLI and Electron preparation; keep the two latency benchmarks exclusive.
# workspace-tabs uses its successful 116-second baseline from run 39920301020.
# shellcheck disable=SC2054 # Each element is one comma-joined shard.
core_shards=(
  core-task-flow,release-package-startup,collaboration-remote-group-coordinate,streaming-message-order,streaming-conversation-switching,task-status-sync,goal-state-sync,rendering-extensions,temporary-chat,streaming-subagents,system-proxy,streaming-timers,running-plan-history,task-attachments,codex-account-login,notification-tab-navigation
  project-assignment-notification,resilience,collaboration-runtime-reconciliation,project-member-overrides,project-automation,streaming-scroll,collaboration-issue-comment-attachments,collaboration-issue-attachment-preview,reply-predictions,streaming-tools,change-request-status,fork-provider-preservation,collaboration-group-onboarding,system-pac,model-settings,tray-lifecycle
  window-lifecycle,model-routing,collaboration-app-queue-identity,stand-in,stand-in-identities,stand-in-connections,stand-in-mcp,stand-in-cli,stand-in-plugin-bridge,stand-in-action-confirmation,stand-in-list-confirmation,stand-in-profile,stand-in-telemetry,embedded-browser,collaboration-human-round-resume,automation-lifecycle,context-compaction,permission-modes,stand-in-notifications,latest-conversation-history,browser-annotation-design,stand-in-controls,stand-in-project-enable,computer-use
  collaboration-board-sorting,component-update,environment-panel-scroll,running-conversation-history,workspace-tabs,collaboration-board-move-recovery,task-board-bulk-actions,core-dsh-plugin-management,voice-input,collaboration-local-group-coordinate,streaming-content,renderer-storage,browser-annotation-anchors,collaboration-issue-comment-mention,cloud-login-proxy
  claude-runtime,cloud-space-mention,local-harness,transcript-sync,collaboration-local-agent-dispatch,collaboration-worktree-policy,stand-in-personal-task,workbench-mode,browser-annotation-core,application-menu,native-window-startup,git-commit-generation,model-overload-recovery,renderer-crash-recovery
  harness-app-lifecycle,task-board-association,remote-device-onboarding,runtime-task-queue,collaboration-issue-mcp-comments,project-ai-settings,running-sidebar-state,reply-prediction-auth,local-file-preview,office-file-preview,collaboration-issue-archive,codex-native-catalog,browser-toolbar-actions,executor-stream-recovery,external-content-import,collaboration-deliveries
  harness-app-development,collaboration-issue-task-discovery,collaboration-remote-agent-dispatch,collaboration-issue-assignment-activity,priority-filter,supervisor-lifecycle,stand-in-permissions,codex-notification-isolation,offline-local-project-space,collaboration-issue-badges,stand-in-workspace,drawing-attachment,codex-invalid-launch-cwd,send-key-preference
  conversation-state,workspace-attachments,goal-lifecycle,collaboration-issue-comment-notification,collaboration-remote-group-planning-details,stand-in-cloud,stand-in-assignment-notifications,background-terminals,plugin-development,collaboration-local-group-cancellation,archived-worktree-cleanup,cloud-context-resilience,dsh-owner-capture,collaboration-first-use,native-window-chrome
  split-workbench
  collaboration-shared-core,runtime-input-answer-persistence
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
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repository_root
  repository_root="$(cd "$script_dir/../.." && pwd)"
  if ! (
    cd "$repository_root"
    node --input-type=module -e '
      import {
        DESKTOP_CHECKPOINTS,
        DESKTOP_CHECKPOINT_GROUPS,
        expandDesktopCheckpoints,
      } from "./wework/e2e/desktop/checkpoints.mjs"
      const registered = DESKTOP_CHECKPOINTS.filter(name => !DESKTOP_CHECKPOINT_GROUPS.has(name))
      if (!registered.length) {
        console.error("Registered desktop checkpoint catalog is empty")
        process.exit(1)
      }
      const covered = new Set(expandDesktopCheckpoints(process.argv.slice(1)))
      for (const checkpoint of registered) {
        if (!covered.has(checkpoint)) {
          console.error(`Registered desktop checkpoint missing from CI catalogs: ${checkpoint}`)
          process.exit(1)
        }
      }
    ' -- "${core_segments[@]}" "${cloud_segments[@]}" "${formal_release_segments[@]}"
  ); then
    printf 'Could not load registered desktop checkpoints\n' >&2
    return 1
  fi
}

validate_registered_checkpoint_coverage

declare -A selected=()
desktop_runner_changed=false
macos_inspector_e2e=false

select_target() {
  selected["$1"]=true
}

select_account_auth_checkpoints() {
  select_target "cloud:plugin-account-auth-password"
  select_target "cloud:plugin-account-auth-transfer"
  select_target "cloud:plugin-account-auth-oauth"
  select_target "cloud:plugin-account-auth-dws"
  select_target "cloud:plugin-account-auth-conversation"
  select_target "cloud:plugin-account-auth-github"
  select_target "cloud:plugin-account-auth-coordination"
}

select_uninstall_checkpoints() {
  select_target "cloud:plugin-uninstall-lost-response"
  select_target "cloud:plugin-uninstall-unknown-result"
  select_target "cloud:plugin-uninstall-restart-recovery"
  select_target "cloud:plugin-uninstall-reinstall-race"
  select_target "cloud:plugin-write-coordination"
  select_target "cloud:plugin-registration-coordination"
  select_target "cloud:plugin-account-auth-coordination"
}

select_plugin_sync_checkpoints() {
  select_target "cloud:plugin-runtime-route-refresh"
  select_target "cloud:plugin-background-sync-isolation"
  select_target "cloud:plugin-periodic-reconcile"
}

select_rendering_checkpoints() {
  select_target "core:rendering-extensions"
  select_target "core:streaming-content"
  select_target "core:streaming-tools"
  select_target "core:streaming-timers"
  select_target "core:streaming-scroll"
  select_target "core:streaming-message-order"
  select_target "core:streaming-conversation-switching"
  select_target "core:streaming-subagents"
}

select_cloud_worktree_checkpoints() {
  local segment
  for segment in "${cloud_worktree_segments[@]}"; do
    select_target "cloud:$segment"
  done
}

select_collaboration_dispatch_checkpoints() {
  select_target "core:collaboration-runtime-reconciliation"
  select_target "core:collaboration-worktree-policy"
  select_target "core:project-assignment-notification"
  select_target "core:collaboration-local-agent-dispatch"
  select_target "core:stand-in"
  select_target "core:stand-in-identities"
  select_target "core:stand-in-connections"
  select_target "core:stand-in-mcp"
  select_target "core:stand-in-cli"
  select_target "core:stand-in-plugin-bridge"
  select_target "core:stand-in-action-confirmation"
  select_target "core:stand-in-list-confirmation"
  select_target "core:stand-in-profile"
  select_target "core:stand-in-telemetry"
  select_target "core:stand-in-workspace"
  select_target "core:stand-in-controls"
  select_target "core:stand-in-project-enable"
  select_target "core:stand-in-cloud"
  select_target "core:stand-in-assignment-notifications"
  select_target "core:stand-in-personal-task"
  select_target "core:stand-in-permissions"
  select_target "core:collaboration-remote-agent-dispatch"
  select_target "core:collaboration-local-group-coordinate"
  select_target "core:collaboration-remote-group-coordinate"
  select_target "core:collaboration-remote-group-planning-details"
  select_target "core:collaboration-human-round-resume"
  select_target "core:collaboration-local-group-cancellation"
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
    wework/e2e/desktop/scenarios/split-workbench.scenario.mjs)
      select_target "core:split-workbench"
      return
      ;;
    wework/e2e/desktop/scenarios/harness-apps.scenario.mjs | \
      wework/e2e/desktop/modules/harness-app-*)
      select_target "core:harness-app-development"
      select_target "core:harness-app-lifecycle"
      return
      ;;
    wework/e2e/desktop/scenarios/streaming-text.scenario.mjs | \
      wework/e2e/desktop/modules/streaming-text-* | \
      wework/e2e/desktop/modules/streaming-conversation-switching.mjs)
      select_rendering_checkpoints
      return
      ;;
  esac

  case "$path" in
    wework/src/features/workbench/runtimeConversationCache* | \
      wework/src/components/layout/useWorkbenchPaneSession* | \
      wework/src/features/workbench/WorkbenchProvider* | \
      wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStreamCoordinator*)
      select_target "core:goal-state-sync"
      ;;
  esac

  case "$path" in
    wework/src/components/chat/composer/Drawing* | \
      wework/src/components/chat/composer/useComposerDrawing* | \
      wework/src/components/chat/composer/drawing-canvas.css | \
      wework/vite/excalidrawAssets* | \
      wework/e2e/desktop/scenarios/drawing-attachment.scenario.mjs)
      select_target "core:drawing-attachment"
      return
      ;;
    # System proxy resolution spans Electron, local runtime request routing,
    # and the proxy settings surface.
    wework/electron/src/host/system-proxy* | \
      wework/src/components/settings/ProxySettingsPage* | \
      wework/src/desktop/systemProxy* | \
      wework/src/api/local/runtimeModelProxy* | \
      wework/src/api/local/codexProviderProxy* | \
      wework/e2e/desktop/scenarios/system-pac.scenario.mjs | \
      wework/e2e/desktop/scenarios/system-proxy.scenario.mjs)
      select_target "core:system-proxy"
      select_target "core:system-pac"
      return
      ;;
    wework/e2e/desktop/modules/terminal-history-search.mjs | \
      wework/e2e/desktop/modules/cached-history-search.mjs | \
      wework/e2e/desktop/modules/conversation-search-contract.mjs)
      select_target "core:running-conversation-history"
      select_target "cloud:conversation-state"
      return
      ;;
    wework/e2e/desktop/modules/cloud-history-search.mjs)
      select_target "cloud:conversation-state"
      return
      ;;
    # Cloud device restart and upgrade actions require the managed Nevis fixture.
    wework/src/components/settings/ConnectionsSettingsPage* | \
      wework/src/components/settings/DeviceVersionBadge* | \
      wework/src/features/cloud-devices/* | \
      wework/e2e/desktop/modules/cloud-device-lifecycle-flow.mjs)
      select_target "cloud:cloud-device-lifecycle"
      return
      ;;
    wework/e2e/desktop/modules/plugin-auth-coordination.mjs | \
      wework/e2e/desktop/modules/plugin-account-auth-fixture.mjs | \
      wework/src/components/plugins/PluginAccountConnections* | \
      wework/src/api/cloud/pluginAccountConnections* | \
      wework/e2e/desktop/modules/dws-account-auth.mjs | \
      wework/e2e/desktop/modules/account-auth-command.mjs | \
      wework/e2e/desktop/modules/github-manage-connection.mjs | \
      wework/e2e/desktop/modules/plugin-conversation-auth.mjs | \
      wework/e2e/desktop/fixtures/dws-account-auth.py | \
      wework/e2e/desktop/fixtures/dws-store/* | \
      wework/e2e/desktop/scenarios/plugin-account-auth.scenario.mjs)
      select_account_auth_checkpoints
      return
      ;;
    wework/e2e/desktop/modules/terminal-compatibility-flows.mjs)
      select_target "cloud:core-task-flow"
      return
      ;;
    wework/e2e/desktop/scenarios/codex-account-login.scenario.mjs)
      select_target "core:codex-account-login"
      return
      ;;

    # Desktop sign-in travels through the operating system proxy, so the main
    # process and the renderer must share one network path.
    wework/electron/src/host/cloud-http* | \
      wework/electron/src/host/cloud-credential-service* | \
      wework/e2e/desktop/modules/cloud-login-proxy-fixtures.mjs | \
      wework/e2e/desktop/scenarios/cloud-login-proxy.scenario.mjs)
      select_target "core:cloud-login-proxy"
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
    wework/e2e/utils/mcp-elicitation-server.mjs | \
      wework/scripts/mcp-elicitation-server.test.mjs)
      select_target "core:permission-modes"
      return
      ;;

    # Workbench mode covers Home migration before the managed Git/settings flow.
    wework/e2e/desktop/scenarios/workbench-mode.scenario.mjs | \
      wework/e2e/desktop/modules/custom-model-output-budget.mjs | \
      wework/e2e/desktop/modules/native-agent-mcp.mjs | \
      wework/e2e/desktop/modules/workbench-home-migration.mjs | \
      wework/e2e/desktop/modules/workbench-schema-compatibility.mjs | \
      wework/e2e/desktop/modules/workbench-desktop-startup.mjs | \
      wework/e2e/desktop/modules/workbench-component-publication.mjs | \
      wework/electron/src/runtime/immutable-directory* | \
      wework/electron/src/runtime/workbench-environment* | \
      wework/electron/src/runtime/development-isolation* | \
      wework/electron/src/runtime/workbench-executor-schema* | \
      wework/electron/src/runtime/workbench-codex-migration* | \
      wework/electron/src/runtime/workbench-migration-lock* | \
      wework/electron/src/runtime/workbench-desktop-startup* | \
      wework/electron/src/runtime/workbench-home-migration* | \
      wework/electron/src/runtime/workbench-mode* | \
      wework/src/features/workbench-mode/*)
      select_target "core:workbench-mode"
      return
      ;;

    # External content import crosses the settings UI and local Executor IPC.
    wework/src/api/local/codexPlugins.ts | \
      wework/src/api/local/codexPlugins.install.test.ts | \
      wework/src/api/local/codexPluginInstallation.ts | \
      wework/src/components/settings/ExternalContentImportDialog.tsx | \
      wework/e2e/desktop/scenarios/external-content-import.scenario.mjs)
      select_target "core:external-content-import"
      if [[ "$path" == wework/src/api/local/codexPlugin* ]]; then
        select_target "plugins:plugin-lifecycle"
        select_target "core:project-ai-settings"
      fi
      return
      ;;

    # Plugin development verifies the installed Codex guide, generated local
    # project, conditional conversation sidebar, isolated Wework, and HMR.
    wework/dsh/plugin-developer/* | \
      wework/e2e/desktop/modules/bundled-plugin-upgrades.mjs | \
      executor/src/local/plugin_cache.rs | \
      executor/src/runtime_work/handler/plugin_install.rs | \
      wework/src/desktop/localExecutor* | \
      wework/src/components/plugins/BundledPluginUpdateNotice* | \
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
        select_target "core:background-terminals"
      fi
      return
      ;;

    wework/dsh/voice-input/* | \
      wework/e2e/desktop/scenarios/voice-input.scenario.mjs)
      select_target "core:voice-input"
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

    # Conversation authorization requires real managed membership and local auth.
    wework/src/features/plugins/localConnectorAuthGate* | \
      wework/src/features/plugins/codexConnectorAuthorization* | \
      wework/src/components/plugins/GithubCliAuthDialog* | \
      wework/src/components/plugins/PluginConnectorSection* | \
      wework/src/components/plugins/LocalConnectorAuthDialog* | \
      wework/src/components/plugins/PluginsWorkspace* | \
      wework/src/components/layout/DesktopEmptyTaskLauncher* | \
      wework/src/features/plugins/useLocalConnectorAuthGate* | \
      wework/src/features/plugins/prefetchLocalConnectorAuth* | \
      wework/src/components/chat/ConnectorAuthCard* | \
      wework/src/features/plugins/useLocalConnectorAuthSession* | \
      wework/src/features/plugins/githubCliAuthGate* | \
      wework/src/api/local/githubCli* | \
      wework/src/api/local/localConnectorAuth*)
      select_account_auth_checkpoints
      select_target "plugins:plugin-lifecycle"
      select_target "core:project-ai-settings"
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

    wework/e2e/desktop/scenarios/task-model-deletion.scenario.mjs)
      select_target "cloud:task-model-deletion"
      return
      ;;

    wework/e2e/desktop/scenarios/cloud-model-presets.scenario.mjs)
      select_target "cloud:cloud-model-presets"
      return
      ;;

    wework/src/api/hybrid/cloudModelCatalog* | \
      wework/e2e/desktop/modules/cloud-model-recovery.mjs | \
      wework/e2e/desktop/scenarios/cloud-model-recovery.scenario.mjs)
      select_target "cloud:cloud-model-recovery"
      return
      ;;

    # The cloud suite covers VNC-related desktop changes.
    wework/src/components/vnc/* | \
      wework/src/pages/DeviceDesktopPage* | \
      wework/src/pages/deviceDesktopRoute.ts)
      select_target "cloud:all"
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

    # Native tray placement must survive process exit on macOS.
    wework/electron/src/host/tray* | \
      wework/e2e/desktop/scenarios/tray-*)
      select_target "core:tray-lifecycle"
      macos_inspector_e2e=true
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

    # The native application menu spans the Electron host declaration and the
    # renderer bridge that reports capability state and runs its actions.
    wework/electron/src/host/application-menu* | \
      wework/src/desktop/applicationMenu* | \
      wework/src/desktop/ApplicationMenuWorkspaceBridge* | \
      wework/src/components/topnav/ApplicationMenuButton* | \
      wework/e2e/desktop/scenarios/application-menu.scenario.mjs)
      select_target "core:application-menu"
      return
      ;;

    wework/e2e/desktop/scenarios/goal-state-sync.scenario.mjs | \
    wework/e2e/desktop/scenarios/goal-stream-order.scenario.mjs | \
      wework/e2e/desktop/scenarios/goal-output-identity.scenario.mjs | \
      wework/src/features/workbench/runtimeTaskLifecycle/goalSynchronization*)
      select_target "core:goal-state-sync"
      return
      ;;

    wework/e2e/desktop/scenarios/notification-tab-navigation.scenario.mjs)
      select_target "core:notification-tab-navigation"
      return
      ;;

    wework/src/features/notifications/* | \
      wework/e2e/desktop/scenarios/stand-in-notifications.scenario.mjs)
      select_target "core:stand-in-assignment-notifications"
      select_target "core:stand-in-notifications"
      select_target "core:stand-in-cloud"
      select_target "core:project-assignment-notification"
      select_target "core:notification-tab-navigation"
      if [[ "$path" == wework/src/features/notifications/WeworkSchemeBridge* || \
        "$path" == wework/src/features/notifications/scheme* ]]; then
        select_target "core:collaboration-issue-comment-notification"
      fi
      return
      ;;

    # Goal creation, idle continuation, and restart recovery.
    wework/src/lib/runtime-goal* | \
      wework/src/components/chat/composer/Goal* | \
      wework/src/features/workbench/runtimeTaskReminders*)
      select_target "core:goal-lifecycle"
      if [[ "$path" == wework/src/features/workbench/runtimeTaskReminders* ]]; then
        select_target "core:stand-in-assignment-notifications"
        select_target "core:stand-in-notifications"
        select_target "core:stand-in-cloud"
      fi
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
    wework/e2e/desktop/scenarios/project-assignment-notification.scenario.mjs)
      select_target "core:project-assignment-notification"
      return
      ;;
    wework/e2e/desktop/scenarios/project-member-overrides.scenario.mjs)
      select_target "core:project-member-overrides"
      return
      ;;
    wework/e2e/desktop/scenarios/cloud-space-mention.scenario.mjs)
      select_target "core:cloud-space-mention"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-shared-core.scenario.mjs | \
      wework/e2e/desktop/modules/collaboration-board-personal-view.mjs | \
      wework/e2e/desktop/modules/collaboration-board-field-drag.mjs | \
      wework/e2e/desktop/modules/collaboration-board-preferences.mjs | \
      wework/e2e/desktop/modules/collaboration-board-tag-drag.mjs | \
      wework/e2e/desktop/modules/project-only-navigation.mjs)
      select_target "core:collaboration-shared-core"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-issue-task-discovery.scenario.mjs)
      select_target "core:collaboration-issue-task-discovery"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-app-queue-identity.scenario.mjs)
      select_target "core:collaboration-app-queue-identity"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-runtime-reconciliation.scenario.mjs | \
      wework/e2e/desktop/modules/database-lock.mjs | \
      wework/e2e/desktop/modules/runtime-event-proxy.mjs | \
      wework/e2e/desktop/modules/runtime-reconciliation-model.mjs | \
      wework/scripts/runtime-event-proxy.test.mjs | \
      wework/scripts/runtime-reconciliation-model.test.mjs)
      select_target "core:collaboration-runtime-reconciliation"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-board-sorting.scenario.mjs)
      select_target "core:collaboration-board-sorting"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-board-move-recovery.scenario.mjs)
      select_target "core:collaboration-board-move-recovery"
      return
      ;;
    wework/e2e/desktop/modules/collaboration-board-flows.mjs)
      select_target "core:collaboration-board-sorting"
      select_target "core:collaboration-board-move-recovery"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-issue-archive.scenario.mjs)
      select_target "core:collaboration-issue-archive"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-worktree-policy.scenario.mjs)
      select_target "core:collaboration-worktree-policy"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-first-use.scenario.mjs)
      select_target "core:collaboration-first-use"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-group-onboarding.scenario.mjs)
      select_target "core:collaboration-group-onboarding"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-identities.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-action-confirmation.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-list-confirmation.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-profile.scenario.mjs|wework/src/features/todo/StandInConnectionSettings*|wework/src/features/todo/StandInDeviceSelect*|wework/src/features/todo/StandInMemory*|wework/src/features/todo/StandInConversation*|wework/src/features/todo/StandInWork*|wework/src/features/todo/StandInPrimaryProfile*|wework/src/features/todo/StandInProposal*|wework/src/features/todo/StandInDingTalkConnections*|wework/src/features/todo/StandInSourceConnections*|wework/e2e/desktop/scenarios/stand-in-connections.scenario.mjs|wework/dsh/connection-*/*|wework/dsh/plugin-runtime/connections*|wework/dsh/plugin-runtime/connection-dependencies*|wework/dsh/plugin-runtime/connection-tools*|executor/src/runtime_work/connection_cli.rs|executor/src/runtime_work/connection_dependencies.rs|wework/e2e/desktop/scenarios/stand-in-cli.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-plugin-bridge.scenario.mjs|wework/e2e/desktop/fixtures/connection-source/*|executor/src/agents/codex/connection_mcp.rs|executor/src/runtime_work/connection_mcp*|wework/e2e/desktop/scenarios/stand-in-mcp.scenario.mjs|executor/src/runtime_work/connection_host.rs|executor/src/runtime_work/handler/connections.rs|wework/src/features/todo/useStandInInbox*|executor/src/runtime_work/handler/stand_in_conversations.rs|executor/src/runtime_work/handler/stand_in_dingtalk_work.rs|executor/src/runtime_work/handler/stand_in_work.rs|executor/src/runtime_work/handler/stand_in_ingress.rs|executor/src/task_runtime/stand_in_memories.rs|executor/src/runtime_work/handler/stand_in_memory.rs|executor/src/task_runtime/stand_in_inbox.rs|executor/src/task_runtime/stand_in_proposals.rs)
      select_target "core:stand-in-identities"
      select_target "core:stand-in-connections"
      select_target "core:stand-in-mcp"
      select_target "core:stand-in-cli"
      select_target "core:stand-in-plugin-bridge"
      select_target "core:stand-in-action-confirmation"
      select_target "core:stand-in-list-confirmation"
      select_target "core:stand-in-profile"
      select_target "core:stand-in-telemetry"
      select_target "core:stand-in"
      select_target "core:stand-in-workspace"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-assignment-notifications.scenario.mjs)
      select_target "core:stand-in-assignment-notifications"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-personal-task.scenario.mjs)
      select_target "core:stand-in-personal-task"
      return
      ;;

    wework/e2e/desktop/scenarios/stand-in-permissions.scenario.mjs)
      select_target "core:stand-in-permissions"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-project-enable.scenario.mjs|wework/src/features/todo/StandInOverviewPage*|wework/src/features/todo/StandInProjectSetup*|wework/src/features/todo/usePersonalStandIn*|wework/src/api/personalStandIn.ts|wework/e2e/desktop/scenarios/stand-in-controls.scenario.mjs|wework/e2e/desktop/scenarios/stand-in.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-cloud.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-workspace.scenario.mjs|wework/src/features/todo/StandInComposer*|wework/src/features/todo/StandInSettingsPage*|wework/src/features/todo/useStandInModels*|wework/src/features/todo/IssueStandInControl*|wework/src/features/todo/StandInIcon.tsx|wework/src/features/todo/useStandInProjects.ts|wework/src/features/todo/useStandInProjects.test.tsx|wework/src/features/todo/StandInPopover.tsx|wework/src/features/todo/StandInPopover.test.tsx|wework/src/api/standIn.ts|wework/src/api/standIn.test.ts|executor/src/runtime_work/handler/stand_in.rs|executor/src/task_runtime/stand_in.rs)
      select_target "core:stand-in"
      select_target "core:stand-in-identities"
      select_target "core:stand-in-connections"
      select_target "core:stand-in-mcp"
      select_target "core:stand-in-cli"
      select_target "core:stand-in-plugin-bridge"
      select_target "core:stand-in-action-confirmation"
      select_target "core:stand-in-list-confirmation"
      select_target "core:stand-in-profile"
      select_target "core:stand-in-telemetry"
      select_target "core:stand-in-workspace"
      select_target "core:stand-in-controls"
      select_target "core:stand-in-project-enable"
      select_target "core:stand-in-cloud"
      select_target "core:stand-in-assignment-notifications"
      select_target "core:stand-in-personal-task"
      select_target "core:stand-in-permissions"
      return
      ;;
    wework/e2e/desktop/modules/workspace-agent-setup.mjs)
      select_target "core:collaboration-local-agent-dispatch"
      select_target "core:collaboration-remote-agent-dispatch"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-local-agent-dispatch.scenario.mjs|wework/e2e/desktop/modules/local-issue-assignee-recovery.mjs)
      select_target "core:collaboration-local-agent-dispatch"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-remote-agent-dispatch.scenario.mjs | \
      wework/e2e/desktop/modules/dispatch-issue-boundary.mjs)
      select_target "core:collaboration-remote-agent-dispatch"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-local-group-coordinate.scenario.mjs)
      select_target "core:collaboration-local-group-coordinate"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-remote-group-coordinate.scenario.mjs)
      select_target "core:collaboration-remote-group-coordinate"
      select_target "core:collaboration-remote-group-planning-details"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-remote-group-planning-details.scenario.mjs)
      select_target "core:collaboration-remote-group-planning-details"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-human-round-resume.scenario.mjs)
      select_target "core:collaboration-human-round-resume"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-local-group-cancellation.scenario.mjs)
      select_target "core:collaboration-local-group-cancellation"
      return
      ;;
    wework/src/components/layout/DesktopWorkbenchLayout.tsx)
      select_all_desktop_suites
      return
      ;;
    # Issue comment/reply mention wiring lives in the shared composers and in
    # the Wework collaboration render path.
    wework/e2e/desktop/scenarios/collaboration-issue-comment-mention.scenario.mjs)
      select_target "core:collaboration-issue-comment-mention"
      return
      ;;
    wework/src/features/todo/IssueAssignmentEvent* | \
      wework/src/features/todo/assignmentHistoryLabels* | \
      wework/src/features/todo/issueActivityTimeline* | \
      wework/src/features/todo/useIssueActivityHistory* | \
      wework/e2e/desktop/scenarios/collaboration-issue-assignment-activity.scenario.mjs)
      select_target "core:collaboration-issue-assignment-activity"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-issue-comment-attachments.scenario.mjs)
      select_target "core:collaboration-issue-comment-attachments"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-issue-attachment-preview.scenario.mjs)
      select_target "core:collaboration-issue-attachment-preview"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-issue-comment-notification.scenario.mjs | \
      wework/e2e/desktop/scenarios/issue-notification-read.scenario.mjs)
      select_target "core:collaboration-issue-comment-notification"
      return
      ;;
    wework/src/features/todo/TaskBoardView* | \
      wework/src/features/workbench/runtimeTaskArchive* | \
      wework/e2e/desktop/scenarios/task-board-bulk-actions.scenario.mjs)
      select_target "core:task-board-bulk-actions"
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
    wework/e2e/desktop/modules/mcp-tool-results.mjs)
      select_target "core:collaboration-issue-mcp-comments"
      select_target "core:collaboration-remote-agent-dispatch"
      return
      ;;
    wework/e2e/desktop/modules/personal-issue-access.mjs | \
      wework/e2e/desktop/modules/real-object-storage.mjs | \
      wework/e2e/desktop/scenarios/collaboration-issue-mcp-comments.scenario.mjs)
      select_target "core:collaboration-issue-mcp-comments"
      return
      ;;
    wework/e2e/desktop/modules/new-task-board-association.mjs)
      select_target "core:task-board-association"
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
      if [[ "$path" == wework/src/api/deliveries* ]]; then
        select_target "core:collaboration-issue-comment-notification"
      fi
      if [[ "$path" == wework/src/api/local/localDelivery* ]]; then
        select_target "core:collaboration-issue-assignment-activity"
        select_target "core:collaboration-human-round-resume"
        select_target "core:collaboration-local-group-coordinate"
        select_target "core:task-board-bulk-actions"
      fi
      if [[ "$path" == wework/src/features/todo/CloudTodoWorkspace* || \
        "$path" == wework/src/features/todo/WorkItemComposerGuide* ]]; then
        select_target "core:collaboration-first-use"
      fi
      if [[ "$path" == wework/src/features/todo/CloudTodoWorkspace* ]]; then
        select_target "core:collaboration-board-sorting"
        select_target "core:collaboration-board-move-recovery"
      fi
      if [[ "$path" == wework/src/components/layout/useWorkbenchCloudProjectContext* ]]; then
        select_target "core:cloud-context-resilience"
      fi
      return
      ;;
    wework/src/features/workbench/projectTaskTracking* | \
      wework/src/features/workbench/workbenchContextTypes*)
      select_target "core:task-status-sync"
      if [[ "$path" == wework/src/features/workbench/workbenchContextTypes* ]]; then
        select_target "core:send-key-preference"
      fi
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
      if [[ "$path" == wework/src/api/local/localServices* || \
        "$path" == wework/src/api/hybrid/hybridServices* ]]; then
        select_target "core:background-terminals"
      fi
      if [[ "$path" == wework/src/api/hybrid/hybridServices* ]]; then
        select_target "core:stand-in-assignment-notifications"
      fi
      if [[ "$path" == wework/src/features/workbench/WorkbenchProvider* ]]; then
        select_target "core:send-key-preference"
      fi
      if [[ "$path" == wework/src/features/workbench/useWorkbenchRuntimeTasks* ]]; then
        select_target "core:runtime-task-queue"
        select_target "core:task-status-sync"
        select_target "core:task-board-bulk-actions"
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
      select_target "core:running-sidebar-state"
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
      select_rendering_checkpoints
      return
      ;;

    # The main workbench owns the independent message scroller and fixed
    # environment panel, plus temporary-chat and project-context integration.
    wework/src/components/layout/DesktopWorkbenchMain.tsx | \
      wework/src/components/layout/DesktopWorkbenchLayout.test.tsx)
      select_target "core:environment-panel-scroll"
      if [[ "$path" == wework/src/components/layout/DesktopWorkbenchMain.tsx ]]; then
        select_target "core:background-terminals"
        select_target "core:temporary-chat"
        select_target "core:cloud-context-resilience"
        select_target "core:task-board-association"
      fi
      return
      ;;

    # Right-workspace temporary chats have an independently bootstrapped
    # ephemeral-thread scenario. Accepted runtime input answers are shared
    # between the main pane and temporary chats.
    wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx | \
      wework/e2e/desktop/scenarios/temporary-chat.scenario.mjs)
      select_target "core:temporary-chat"
      select_target "core:runtime-input-answer-persistence"
      return
      ;;
    wework/e2e/desktop/scenarios/runtime-input-answer-persistence.scenario.mjs)
      select_target "core:runtime-input-answer-persistence"
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
      select_target "core:runtime-input-answer-persistence"
      select_target "core:project-ai-settings"
      select_target "core:claude-runtime"
      select_cloud_worktree_checkpoints
      return
      ;;

    wework/e2e/desktop/modules/shared-skill-runtime.mjs)
      select_target "core:claude-runtime"
      return
      ;;

    wework/src/components/layout/BackgroundTerminalsSummary* | \
      wework/src/components/layout/backgroundTerminals* | \
      wework/src/components/layout/workspace-panels/BackgroundTerminalPanel* | \
      wework/src/api/runtimeBackgroundTerminals.ts | \
      wework/e2e/desktop/scenarios/background-terminals.scenario.mjs)
      select_target "core:background-terminals"
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

    # File editing and Office previews have independently bootstrapped checkpoints.
    wework/electron/src/host/local-workspace-files* | \
      wework/src/desktop/localWorkspaceFiles* | \
      wework/src/components/layout/workspace-panels/FileWorkspacePanel* | \
      wework/src/components/layout/workspace-panels/WorkspaceFilePreview* | \
      wework/src/components/layout/workspace-panels/WorkspaceFileTree* | \
      wework/src/components/layout/workspace-panels/WorkspaceTextFileEditor* | \
      wework/src/components/chat/FileChangesReviewPanel* | \
      wework/e2e/desktop/scenarios/local-file-preview.scenario.mjs)
      select_target "core:local-file-preview"
      select_target "core:office-file-preview"
      return
      ;;
    wework/e2e/desktop/scenarios/office-file-preview.scenario.mjs | \
      wework/e2e/desktop/modules/office-preview-fixtures.mjs | \
      wework/src/e2e/desktop-control-wheel*)
      select_target "core:office-file-preview"
      return
      ;;

    # Runtime queue orchestration has an independently bootstrapped checkpoint.
    wework/e2e/desktop/scenarios/runtime-task-queue.scenario.mjs)
      select_target "core:runtime-task-queue"
      return
      ;;
    wework/e2e/desktop/scenarios/codex-invalid-launch-cwd.scenario.mjs)
      select_target "core:codex-invalid-launch-cwd"
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
    wework/e2e/desktop/scenarios/model-overload-recovery.scenario.mjs)
      select_target "core:model-overload-recovery"
      return
      ;;
    wework/e2e/desktop/scenarios/send-key-preference.scenario.mjs)
      select_target "core:send-key-preference"
      return
      ;;
    wework/dsh/transcript-sync/* | \
      wework/dsh/executor-runtime/session-projector* | \
      wework/electron/src/host/wework-sync-request* | \
      wework/e2e/desktop/scenarios/transcript-sync.scenario.mjs)
      select_target "core:transcript-sync"
      return
      ;;

    wework/src/api/commitMessage* | \
      wework/e2e/desktop/scenarios/git-commit-generation.scenario.mjs)
      select_target "core:git-commit-generation"
      return
      ;;

    wework/e2e/desktop/scenarios/collaboration-issue-badges.scenario.mjs | \
      wework/src/features/todo/IssueBadges* | \
      wework/src/features/change-requests/*)
      select_target "core:collaboration-issue-badges"
      return
      ;;

    # Git hosting preferences and explicit device synchronization share one
    # independently bootstrapped desktop checkpoint.
    wework/src/api/devices* | \
      wework/src/components/settings/GitHostingSettingsPage* | \
      wework/src/types/gitCredentials.ts | \
      wework/e2e/desktop/scenarios/change-request-status.scenario.mjs)
      select_target "core:change-request-status"
      return
      ;;

    wework/e2e/desktop/scenarios/codex-native-catalog.scenario.mjs)
      select_target "core:codex-native-catalog"
      return
      ;;
    wework/e2e/desktop/scenarios/model-settings.scenario.mjs | \
      wework/src/components/settings/ProviderSettingsSection* | \
      wework/src/components/settings/ProviderEditor* | \
      wework/src/components/settings/ProviderModelFields* | \
      wework/src/components/settings/ModelSettingsPage* | \
      wework/src/features/model-settings/provider*)
      select_target "core:model-settings"
      select_target "core:codex-account-login"
      select_target "core:model-routing"
      return
      ;;

    wework/e2e/desktop/scenarios/latest-conversation-history.scenario.mjs)
      select_target "core:latest-conversation-history"
      return
      ;;

    # Assistant/tool rendering and desktop extension surfaces.
    wework/src/components/chat/blocks/* | \
      wework/src/components/chat/AttachmentImagePreview* | \
      wework/src/extensions/desktop* | \
      wework/e2e/desktop/scenarios/*)
      select_rendering_checkpoints
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
      if [[ "$path" == wework/src/components/chat/composer/ComposerToolbar* || \
        "$path" == wework/src/components/chat/composer/ComposerTextarea* || \
        "$path" == wework/src/components/chat/composer/CompactChatComposer* ]]; then
        select_target "core:drawing-attachment"
      fi
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
    wework/e2e/desktop/scenarios/plugin-runtime-route-refresh.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-composer-route-messaging.mjs)
      select_target "cloud:plugin-runtime-route-refresh"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-background-sync-isolation.scenario.mjs)
      select_target "cloud:plugin-background-sync-isolation"
      return
      ;;
    wework/e2e/desktop/modules/plugin-sync-observer.mjs | \
      backend/app/services/plugin_device_identity.py)
      select_plugin_sync_checkpoints
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-periodic-reconcile.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-periodic-reconcile*.mjs)
      select_target "cloud:plugin-periodic-reconcile"
      return
      ;;
  esac

  case "$path" in
    backend/app/services/plugin_device_sync.py | \
      backend/app/api/endpoints/installed_plugins.py)
      select_plugin_sync_checkpoints
      ;;
    wework/src/features/plugins/pluginDeviceApi* | \
      wework/src/desktop/localExecutor* | \
      wework/src/components/plugins/PluginsWorkspace*)
      select_target "cloud:plugin-runtime-route-refresh"
      select_target "cloud:plugin-background-sync-isolation"
      ;;
  esac

  case "$path" in
    packages/chat-core/test-fixtures/conversation-search-contract.json)
      select_target "core:running-conversation-history"
      select_target "cloud:conversation-state"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-runtime-path-recovery.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-runtime-path-fixture.mjs | \
      wework/scripts/plugin-runtime-path-fixture.test.mjs)
      select_target "cloud:plugin-runtime-path-recovery"
      return
      ;;
  esac

  case "$path" in
    backend/app/core/distributed_lock.py | \
      backend/app/services/plugin_write_*.py | \
      backend/app/services/plugin_kind_revision.py | \
      backend/app/services/plugin_policy_revision.py)
      select_account_auth_checkpoints
      select_uninstall_checkpoints
      select_target "cloud:plugin-auto-update"
      ;;
  esac

  case "$path" in
    backend/app/api/ws/device_namespace.py | \
      backend/app/api/endpoints/loop_item_executions.py | \
      backend/app/schemas/runtime_execution_snapshot.py | \
      backend/app/services/project_chat/execution_snapshot.py | \
      backend/app/services/loop_item_executions/* | \
      backend/tests/api/ws/test_device_namespace*.py | \
      backend/tests/api/ws/test_device_reconnect_storm.py | \
      backend/tests/api/ws/test_device_runtime_content_reconciliation.py | \
      backend/tests/api/test_loop_item_executions_api.py | \
      backend/tests/schemas/test_runtime_execution_snapshot*.py | \
      backend/tests/services/test_loop_item_executions.py | \
      backend/tests/services/test_project_chat_execution_snapshot.py)
      select_target "core:collaboration-runtime-reconciliation"
      ;;
  esac

  case "$path" in
    backend/app/api/endpoints/cloud_projects.py | \
      backend/app/api/endpoints/workspaces.py | \
      backend/app/schemas/cloud_project.py | backend/app/schemas/workspace.py | \
      backend/app/services/cloud_project_visibility.py | \
      backend/app/services/cloud_projects/* | backend/app/services/workspaces/* | \
      backend/app/services/collaboration_permissions.py | \
      backend/app/services/collaboration_revocation.py | \
      backend/app/services/issue_assignments.py | \
      backend/tests/api/test_collaboration_permission_contract.py | \
      backend/tests/api/test_cloud_project* | \
      backend/tests/services/test_cloud_project* | \
      backend/tests/services/test_loop_item_assignment.py | \
      backend/tests/test_collaboration_permission_guard.py | \
      backend/integration_checks/test_rust_collaboration_permissions_mysql.py | \
      packages/collaboration/src/project-manage/* | \
      packages/collaboration/src/CollaborationApp* | \
      packages/collaboration/src/http-api/createSharedWorkspaceHttpApi* | \
      packages/collaboration/src/ports/SharedWorkspaceApi* | \
      packages/collaboration/src/types*)
      select_target "core:project-member-overrides"
      ;;
  esac

  case "$path" in
    packages/collaboration/src/controls/ModelSelector* | \
      packages/collaboration/src/controls/ModelPowerSlider* | \
      packages/collaboration/src/controls/model-selector-utils*)
      select_target "cloud:cloud-model-presets"
      ;;
  esac
  case "$path" in
    packages/collaboration/src/conversation/McpUrlAuthorizationCard* | \
      packages/collaboration/src/conversation/RequestUserInputCard* | \
      wework/src/components/chat/RequestUserInputCard*)
      select_target "core:permission-modes"
      ;;
  esac
  case "$path" in
    backend/app/api/endpoints/installed_plugins.py | \
      backend/app/api/ws/device_namespace.py | \
      backend/app/services/device/plugin_reconciliation.py | \
      backend/app/services/device/plugin_removal_sync.py | \
      backend/app/services/plugin_device_installation_service.py | \
      backend/app/services/plugin_device_sync.py | \
      backend/app/services/plugin_installation_operations.py | \
      backend/app/services/plugin_marketplace_service.py | \
      wework/src/api/pluginUninstall* | wework/src/api/plugins.ts | \
      wework/src/features/plugins/pluginInventory* | \
      wework/src/features/plugins/pluginMarketplaceCache* | \
      wework/src/components/plugins/PluginsWorkspace* | \
      wework/src/components/plugins/PluginManagementWorkspace* | \
      packages/chat-core/src/installed-plugin-merge.ts)
      select_uninstall_checkpoints
      ;;
  esac
  case "$path" in
    wework/src/features/plugins/useOpenAiPluginCatalog* | \
      wework/src/features/plugins/remotePluginError* | \
      wework/src/api/local/codexPlugins* | \
      wework/e2e/desktop/modules/plugin-flows.mjs)
      select_target "plugins:plugin-composer-network-isolation"
      ;;
  esac
  case "$path" in
    packages/collaboration/src/composer/PluginPickerMenu.tsx | \
      wework/src/components/chat/composer/PluginPickerMenu* | \
      wework/src/components/chat/composer/composerAppsSnapshot* | \
      wework/src/components/plugins/PluginManagementWorkspace* | \
      wework/src/features/plugins/pluginInventory*)
      select_target "cloud:plugin-composer-long-list"
      ;;
    wework/e2e/desktop/scenarios/plugin-uninstall-resilience.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-registration-coordination.mjs | \
      wework/e2e/desktop/support/registration-capabilities.py | \
      wework/e2e/desktop/modules/plugin-write-coordination.mjs | \
      wework/e2e/desktop/modules/plugin-sync-disconnect.mjs | \
      wework/e2e/desktop/modules/plugin-write-lease.mjs | \
      wework/e2e/desktop/support/plugin-write-lease.py)
      select_uninstall_checkpoints
      return
      ;;
    wework/scripts/plugin-fault-proxy.test.mjs | \
      wework/e2e/desktop/modules/transport-fault-proxy*)
      select_uninstall_checkpoints
      select_target "cloud:conversation-state"
      if [[ "$path" == wework/e2e/desktop/modules/transport-fault-proxy* ]]; then
        select_plugin_sync_checkpoints
        select_target "core:collaboration-board-move-recovery"
      fi
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-composer-long-list.scenario.mjs)
      select_target "cloud:plugin-composer-long-list"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-collaboration-composer-isolation.scenario.mjs | \
      packages/chat-core/src/runtime-composer-api* | \
      packages/chat-core/src/runtime-composer-snapshot* | \
      executor/src/runtime_work/handler/composer_catalog*)
      select_target "cloud:plugin-collaboration-composer-isolation"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-toggle-persistence.scenario.mjs)
      select_target "cloud:plugin-toggle-persistence"
      return
      ;;
    wework/e2e/desktop/modules/plugin-inventory-state.mjs | \
      wework/scripts/plugin-inventory-state.test.mjs)
      select_target "cloud:plugin-runtime-path-recovery"
      select_target "cloud:plugin-toggle-persistence"
      return
      ;;
    wework/e2e/desktop/modules/plugin-regression-fixture.mjs)
      select_plugin_sync_checkpoints
      select_target "cloud:plugin-toggle-persistence"
      select_uninstall_checkpoints
      select_target "cloud:plugin-composer-long-list"
      select_target "cloud:plugin-collaboration-composer-isolation"
      return
      ;;
  esac

  case "$path" in
    sdk/plugin-creator/* | sdk/plugin-auth/* | executor/src/local/plugin_creator.rs | \
      wework/src/components/plugins/PluginCreateWorkspace* | \
      wework/e2e/desktop/modules/plugin-flows.mjs)
      select_target "plugins:plugin-marketplace-lifecycle"
      if [[ "$path" == wework/e2e/desktop/modules/plugin-flows.mjs ]]; then
        select_target "plugins:plugin-lifecycle"
      fi
      select_target "cloud:plugin-workspace-publication"
      ;;
    backend/app/schemas/issue_workflow.py | \
      backend/app/schemas/project_chat.py | \
      backend/app/schemas/runtime_work.py | \
      backend/app/services/cloud_projects/service.py | \
      backend/app/services/issue_execution_configuration.py | \
      backend/app/services/loop_item_executions/* | \
      backend/app/api/endpoints/issue_dispatches.py | \
      backend/app/schemas/issue_dispatch.py | \
      backend/app/services/issue_dispatch*.py | \
      backend/tests/api/test_issue_dispatches_api.py | \
      backend/tests/services/test_issue_dispatch*.py | \
      backend/app/services/project_automation_* | \
      backend/app/services/project_automations.py | \
      backend/app/services/project_chat/* | \
      backend/app/services/project_workflow_projection.py | \
      backend/app/services/runtime_work_service.py | \
      backend/tests/api/test_cloud_projects_api.py | \
      backend/tests/schemas/test_issue_workflow.py | \
      backend/tests/services/test_coordinator_configuration.py | \
      backend/tests/services/test_loop_item_executions.py | \
      backend/tests/services/test_project_automations.py | \
      backend/tests/services/test_project_chat_service.py | \
      backend/tests/services/test_project_workflow_projection.py | \
      backend/tests/services/test_runtime_work_service.py | \
      executor/src/agents/claude_code.rs | \
      executor/src/agents/mod.rs | \
      executor/src/agents/runtime_capabilities.rs | \
      executor/src/runtime_work/events.rs | \
      executor/src/runtime_work/handler.rs | \
      executor/src/runtime_work/handler/claude_turns.rs | \
      executor/src/runtime_work/util.rs | \
      executor/src/services/skill_deployer.rs | \
      executor/src/task_runtime/model.rs | \
      executor/src/task_runtime/store.rs)
      select_collaboration_dispatch_checkpoints
      ;;
  esac

  case "$path" in
    sdk/plugin-auth/* | sdk/plugin-auth-go/* | sdk/dws-auth/* | executor/src/plugin_account_auth/* | \
      executor/tests/plugin_account_auth_contract.rs | \
      backend/app/services/plugin_account* | backend/app/services/plugin_auth* | \
      backend/app/services/plugin_oauth* | backend/app/services/plugin_credential* | \
      backend/app/schemas/plugin_account_auth.py | backend/app/api/ws/plugin_auth_broker.py | \
      backend/app/api/endpoints/plugin_connections.py)
      select_account_auth_checkpoints
      ;;
    executor/src/runtime_work/codex_transcript_page.rs)
      select_target "core:transcript-sync"
      select_target "core:environment-panel-scroll"
      ;;
    backend/alembic/versions/*wework_transcript* | \
      backend/app/api/endpoints/wework_transcripts.py | \
      backend/app/core/wework_transcript_encryption.py | \
      backend/app/models/wework_transcript.py | \
      backend/app/schemas/wework_transcript.py | \
      backend/app/services/wework_transcript_* | \
      backend/tests/api/endpoints/test_wework_transcripts_api.py | \
      backend/tests/models/test_wework_transcript_schema.py | \
      executor/src/runtime_work/native_transcript.rs | \
      executor/src/runtime_work/handler/transcript_sync.rs)
      select_target "core:transcript-sync"
      ;;
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
    wework/e2e/desktop/scenarios/collaboration-deliveries.scenario.mjs | \
      packages/collaboration/src/issue-detail/IssueDelivery* | \
      packages/collaboration/src/issue-detail/deliveryMessages*)
      select_target "core:collaboration-deliveries"
      ;;
    packages/collaboration/src/platform/WorkspaceResourceConfiguration* | \
      packages/collaboration/src/project-agent-config/* | \
      packages/collaboration/src/http-api/createSharedWorkspaceHttpApi* | \
      packages/collaboration/src/ports/SharedWorkspaceApi* | \
      packages/collaboration/src/dto-mappers/workspaceDtoMappers*)
      select_target "core:remote-device-onboarding"
      select_target "core:collaboration-shared-core"
      select_target "core:collaboration-issue-archive"
      select_target "core:collaboration-first-use"
      select_target "core:collaboration-group-onboarding"
      select_collaboration_dispatch_checkpoints
      select_target "cloud:cloud-device-lifecycle"
      if [[ "$path" == packages/collaboration/src/dto-mappers/workspaceDtoMappers* ]]; then
        select_target "core:collaboration-deliveries"
      fi
      ;;
    packages/collaboration/*)
      if [[ "$path" == packages/collaboration/src/composer/* ]]; then
        select_target "core:drawing-attachment"
      fi
      select_target "core:collaboration-shared-core"
      select_target "core:collaboration-issue-archive"
      select_target "core:collaboration-first-use"
      select_target "core:collaboration-group-onboarding"
      select_collaboration_dispatch_checkpoints
      select_target "core:collaboration-issue-comment-mention"
      select_target "core:collaboration-issue-assignment-activity"
      select_target "core:collaboration-issue-comment-attachments"
      select_target "core:collaboration-issue-attachment-preview"
      select_target "core:collaboration-issue-comment-notification"
      select_target "core:collaboration-board-sorting"
      select_target "core:collaboration-board-move-recovery"
      if [[ "$path" == packages/collaboration/src/issue-detail/IssueExecutionLists* ||
        "$path" == packages/collaboration/src/issue-detail/createSharedIssueDetailPort* ||
        "$path" == packages/collaboration/src/SharedIssueDetailEditor* ]]; then
        select_target "core:collaboration-deliveries"
      fi
      ;;
    executor/src/server/codex_model_catalog*.rs)
      select_target "core:codex-native-catalog"
      ;;
    executor/* | packages/chat-core/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      select_all_desktop_suites
      ;;
    backend/app/api/endpoints/adapter/attachments.py | \
      backend/tests/api/endpoints/adapter/test_attachment_download_policy_routes.py | \
      backend/tests/api/endpoints/adapter/test_content_disposition.py | \
      backend/app/api/endpoints/cloud_projects.py | \
      backend/app/api/endpoints/deliveries.py | \
      backend/tests/api/test_cloud_projects_api.py | \
      backend/tests/api/test_deliveries_api.py)
      select_target "core:collaboration-issue-attachment-preview"
      ;;
    backend-rs/* | backend-rs/** | \
      wework/e2e/desktop/modules/cloud-environment.mjs | \
      wework/e2e/desktop/modules/task-flow-main.mjs | \
      wework/e2e/desktop/support/mysql-helper.py)
      select_all_desktop_suites
      ;;
    .github/workflows/wework-e2e.yml | \
      .github/actions/build-wework-core-e2e/* | \
      docker/wework-e2e/* | \
      .github/scripts/download-actions-artifact.sh | \
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
