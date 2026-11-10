classify_wework_path() {
  local path="$1"

  # Installer packaging changes retain the formal release startup checkpoint.
  case "$path" in
    wework/electron/electron-builder.config.cjs | \
      wework/e2e/desktop/modules/windows-installer-ui.ps1 | \
      wework/e2e/desktop/windows-installer*)
      select_target "core:release-package-startup"
      return
      ;;
  esac

  case "$path" in
    wework/src/components/plugins/PluginDetailView* | \
      wework/src/components/plugins/PluginsWorkspace* | \
      wework/src/components/plugins/pluginOwnerActions.ts | \
      wework/src/components/plugins/pluginOwnerLocalPackage.ts | \
      wework/src/components/plugins/pluginUninstall.ts | \
      wework/src/api/local/codexPlugins.ts | \
      wework/src/features/plugins/pluginMarketplaceCache.ts | \
      wework/src/components/plugins/findMarketplaceItemForInstalled.ts | \
      wework/src/components/plugins/marketplaceCatalogMerge.ts | \
      wework/src/components/plugins/plugin-dialogs/InstallPluginDialog.tsx | \
      wework/src/components/plugins/plugin-dialogs/UninstallPluginDialog.tsx | \
      wework/src/components/plugins/PluginVersionSubmit* | \
      wework/src/components/plugins/pluginVersionSubmission* | \
      wework/src/components/plugins/hooks/usePluginDetailSelection* | \
      wework/src/components/plugins/hooks/usePluginVersionSubmission*)
      select_target "cloud:plugin-workspace-publication"
      select_target "cloud:plugin-toggle-persistence"
      ;;
  esac

  case "$path" in
    wework/e2e/desktop/scenarios/project-space-tool-discovery.scenario.mjs)
      select_target "core:project-space-tool-discovery"
      return
      ;;
    wework/e2e/desktop/scenarios/board-transcript-followup.scenario.mjs | \
      wework/src/features/todo/useBoardRuntimeConversations*)
      select_target "core:board-transcript-followup"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-home-preload.scenario.mjs)
      select_target "core:collaboration-home-preload"
      return
      ;;
    wework/e2e/desktop/scenarios/device-artifact-declaration.scenario.mjs)
      select_target "core:device-artifact-declaration"
      return
      ;;
    wework/e2e/desktop/scenarios/local-artifact-declaration.scenario.mjs)
      select_target "core:local-artifact-declaration"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-installation.scenario.mjs | \
      wework/scripts/plugin-personal-runtime.test.mjs | \
      wework/e2e/desktop/modules/plugin-personal-version-flow.mjs | \
      wework/e2e/desktop/modules/plugin-personal-recipient-install.mjs | \
      wework/e2e/desktop/modules/plugin-personal-uninstall-flow.mjs)
      select_target "cloud:plugin-toggle-persistence"
      return
      ;;
    wework/e2e/desktop/scenarios/split-workbench.scenario.mjs)
      select_target "core:split-workbench"
      return
      ;;
    wework/e2e/desktop/modules/github-release-asset.mjs)
      select_target "core:harness-app-development"
      select_target "core:harness-app-lifecycle"
      select_target "core:harness-app-models"
      select_target "cloud:plugin-legacy-upgrade"
      return
      ;;
    wework/e2e/desktop/scenarios/harness-apps.scenario.mjs | \
      wework/e2e/desktop/modules/dsh-runtime-cache.mjs | \
      wework/electron/src/host/e2e-dsh-release-redirect.ts | \
      wework/e2e/desktop/modules/harness-app-*)
      select_target "core:harness-app-development"
      select_target "core:harness-app-lifecycle"
      select_target "core:harness-app-models"
      return
      ;;
    wework/e2e/desktop/modules/smart-app-*)
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
    wework/e2e/desktop/scenarios/python-runtime.scenario.mjs | \
      wework/e2e/desktop/modules/managed-python.mjs | \
      wework/electron/src/runtime/python-runtime* | \
      wework/src/desktop/executionEnvironments* | \
      wework/src/components/settings/ExecutionEnvironmentsSettingsPage*)
      select_target "core:python-runtime"
      select_target "core:plugin-development"
      select_target "cloud:plugin-account-auth-password"
      return
      ;;
    wework/src/features/workbench/runtimeConversationCache* | \
      wework/src/components/layout/useWorkbenchPaneSession* | \
      wework/src/features/workbench/WorkbenchProvider* | \
      wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStreamCoordinator*)
      select_target "core:goal-state-sync"
      select_target "core:native-lifecycle"
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
      wework/e2e/desktop/modules/codex-startup-history.mjs | \
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

    # Keep startup interruption recovery covered when its host implementation changes.
    wework/electron/src/host/renderer-startup-loader* | \
      wework/electron/src/host/e2e-startup-network-fault* | \
      wework/e2e/desktop/scenarios/startup-network-change.scenario.mjs)
      select_target "core:startup-network-change"
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

    wework/e2e/desktop/scenarios/responses-api-gateway.scenario.mjs)
      # The registered Responses checkpoint runs inside this existing Cloud lifecycle.
      select_target "cloud:plugin-account-auth-dws"
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

    # Windows restores precision-touchpad input through the native window
    # visibility lifecycle, so background policy changes own this checkpoint.
    wework/electron/src/host/window-background-policy* | \
      wework/e2e/desktop/scenarios/window-background-policy.scenario.mjs)
      select_target "core:window-background-policy"
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

    wework/e2e/desktop/scenarios/native-lifecycle.scenario.mjs | \
      wework/e2e/desktop/scenarios/native-guidance.scenario.mjs)
      select_target "core:native-lifecycle"
      return
      ;;
    wework/e2e/desktop/scenarios/goal-state-sync.scenario.mjs | \
    wework/e2e/desktop/scenarios/goal-stream-order.scenario.mjs | \
      wework/e2e/desktop/scenarios/goal-output-identity.scenario.mjs | \
      wework/src/features/workbench/runtimeTaskLifecycle/goalSynchronization*)
      select_target "core:goal-state-sync"
      return
      ;;

    wework/e2e/desktop/scenarios/follow-up-task-switch.scenario.mjs | \
      wework/e2e/desktop/modules/follow-up-agent-history.mjs)
      select_target "core:follow-up-task-switch"
      return
      ;;

    wework/e2e/desktop/scenarios/notification-tab-navigation.scenario.mjs)
      select_target "core:notification-tab-navigation"
      return
      ;;

    wework/e2e/desktop/scenarios/human-interactions.scenario.mjs | \
      wework/e2e/desktop/modules/human-interaction-*.mjs | \
      wework/src/features/notifications/* | \
      wework/e2e/desktop/scenarios/stand-in-notifications.scenario.mjs)
      select_target "core:stand-in-assignment-notifications"
      select_target "core:stand-in-notifications"
      select_target "core:stand-in-cloud"
      select_target "core:project-assignment-notification"
      select_target "core:notification-tab-navigation"
      select_target "core:human-interactions"
      select_target "core:human-interactions-browser"
      select_target "core:human-interactions-hidden"
      select_target "core:human-interactions-issue"
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
    wework/e2e/desktop/scenarios/collaboration-board-backlog.scenario.mjs)
      select_target "core:collaboration-board-backlog"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-parent-board.scenario.mjs)
      select_target "core:collaboration-parent-board"
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
      select_target "core:collaboration-board-backlog"
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
  esac
  classify_workbench_path "$path"
}
