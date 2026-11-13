classify_workbench_path() {
  local path="$1"

  case "$path" in
    wework/e2e/desktop/scenarios/stand-in-email.scenario.mjs|wework/e2e/desktop/modules/real-mail-server.mjs|wework/src/features/todo/StandInEmailConnections*|wework/dsh/connection-runtime/email*)
      select_target "core:stand-in-email"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-identities.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-action-confirmation.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-list-confirmation.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-profile.scenario.mjs|wework/src/features/todo/StandInConnectionSettings*|wework/src/features/todo/StandInDeviceSelect*|wework/src/features/todo/StandInMemory*|wework/src/features/todo/StandInConversation*|wework/src/features/todo/StandInWork*|wework/src/features/todo/StandInPrimaryProfile*|wework/src/features/todo/StandInProposal*|wework/src/features/todo/StandInDingTalkConnections*|wework/src/features/todo/StandInSourceConnections*|wework/e2e/desktop/scenarios/stand-in-connections.scenario.mjs|wework/dsh/connection-*/*|wework/dsh/plugin-runtime/connections*|wework/dsh/plugin-runtime/connection-dependencies*|wework/dsh/plugin-runtime/connection-tools*|executor/src/runtime_work/connection_cli.rs|executor/src/runtime_work/connection_dependencies.rs|wework/e2e/desktop/scenarios/stand-in-cli.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-plugin-bridge.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-alternate-source.scenario.mjs|wework/e2e/desktop/fixtures/connection-source/*|executor/src/agents/codex/connection_mcp.rs|executor/src/runtime_work/connection_mcp*|wework/e2e/desktop/scenarios/stand-in-mcp.scenario.mjs|executor/src/runtime_work/connection_host.rs|executor/src/runtime_work/handler/connections.rs|wework/src/features/todo/useStandInInbox*|executor/src/runtime_work/handler/stand_in_conversations.rs|executor/src/runtime_work/handler/stand_in_dingtalk_work.rs|executor/src/runtime_work/handler/stand_in_work.rs|executor/src/runtime_work/handler/stand_in_ingress.rs|executor/src/task_runtime/stand_in_memories.rs|executor/src/runtime_work/handler/stand_in_memory.rs|executor/src/task_runtime/stand_in_inbox.rs|executor/src/task_runtime/stand_in_proposals.rs)
      select_target "core:stand-in-identities"
      select_target "core:stand-in-connections"
      select_target "core:stand-in-git"
      select_target "core:stand-in-mcp"
      select_target "core:stand-in-cli"
      select_target "core:stand-in-plugin-bridge"
      select_target "core:stand-in-alternate-source"
      select_target "core:stand-in-action-confirmation"
      select_target "core:stand-in-email"
      select_target "core:stand-in-list-confirmation"
      select_target "core:stand-in-profile"
      select_target "core:stand-in-telemetry"
      select_target "core:stand-in"
      select_target "core:stand-in-workspace"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-automation-assignment.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-assignment-notifications.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-assignment-suite.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-assignment-recovery.scenario.mjs|wework/e2e/desktop/modules/stand-in-round-assignment.mjs)
      select_target "core:stand-in-assignment-notifications"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-personal-task.scenario.mjs)
      select_target "core:stand-in-personal-task"
      return
      ;;

    wework/e2e/desktop/scenarios/telemetry-policy.scenario.mjs|wework/e2e/desktop/scenarios/stand-in-telemetry.scenario.mjs)
      select_target "core:stand-in-telemetry"
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
      select_target "core:stand-in-git"
      select_target "core:stand-in-mcp"
      select_target "core:stand-in-cli"
      select_target "core:stand-in-plugin-bridge"
      select_target "core:stand-in-alternate-source"
      select_target "core:stand-in-action-confirmation"
      select_target "core:stand-in-email"
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
    wework/e2e/desktop/scenarios/collaboration-local-agent-dispatch.scenario.mjs | \
      wework/e2e/desktop/scenarios/collaboration-local-status-automation.scenario.mjs | \
      wework/e2e/desktop/modules/local-issue-assignee-recovery.mjs)
      select_target "core:collaboration-local-agent-dispatch"
      return
      ;;
    wework/e2e/desktop/scenarios/collaboration-remote-agent-dispatch.scenario.mjs | \
      wework/e2e/desktop/modules/unconfigured-issue-archive.mjs | \
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
    wework/src/lib/clipboard-images* | \
      wework/src/features/todo/TaskDescriptionEditor* | \
      wework/src/components/chat/composer/desktopComposerServices* | \
      wework/electron/src/host/clipboard-image-conversion* | \
      wework/e2e/desktop/scenarios/clipboard-history-image.scenario.mjs)
      select_target "core:clipboard-history-image"
      macos_inspector_e2e=true
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
      select_target "core:project-space-tool-discovery"
      select_target "core:collaboration-issue-mcp-comments"
      select_target "core:collaboration-remote-agent-dispatch"
      return
      ;;
    wework/e2e/desktop/modules/real-object-storage.mjs)
      select_target "core:collaboration-issue-mcp-comments"
      select_target "cloud:plugin-write-coordination"
      select_target "cloud:plugin-runtime-route-refresh"
      select_target "cloud:plugin-background-sync-isolation"
      select_target "cloud:plugin-periodic-reconcile"
      return
      ;;
    wework/e2e/desktop/modules/personal-issue-access.mjs | \
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
        select_target "core:collaboration-parent-board"
        select_target "core:collaboration-board-sorting"
        select_target "core:collaboration-board-backlog"
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
      select_target "core:board-transcript-followup"
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
    wework/e2e/desktop/scenarios/runtime-input-answer-persistence.scenario.mjs | \
      wework/e2e/desktop/scenarios/consecutive-questions.scenario.mjs | \
      wework/e2e/desktop/modules/interaction-draft-windows.mjs | \
      wework/e2e/desktop/modules/native-reply-recovery.mjs | \
      wework/e2e/desktop/modules/pending-interactions-tab.mjs)
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

    # Scheme interception and the agent fixture exercise the shared embedded browser.
    wework/electron/src/host/embedded-browser-manager* | \
      wework/e2e/desktop/scenarios/embedded-browser-agent.scenario.mjs)
      select_target "core:embedded-browser"
      return
      ;;

    # The remaining embedded browser code has dedicated toolbar and annotation checkpoints.
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

    wework/src/features/mcp-apps/* | \
      wework/src/api/mcpApps.ts | \
      wework/electron/src/host/mcp-app-documents* | \
      executor/src/agents/codex/mcp_apps.rs | \
      executor/src/runtime_work/handler/mcp_apps.rs | \
      wework/e2e/desktop/scenarios/mcp-apps.scenario.mjs | \
      wework/e2e/desktop/scenarios/ordinary-mcp-regression.mjs | \
      wework/e2e/utils/mcp-app-server.mjs)
      select_target "core:mcp-apps"
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

    wework/e2e/desktop/modules/harness-tool-result-order.*)
      select_target "core:local-harness"
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

    # File editing, Cloud HTML links, and Office previews have independently
    # bootstrapped checkpoints.
    wework/electron/src/host/local-workspace-files* | \
      wework/src/desktop/localWorkspaceFiles* | \
      wework/src/components/layout/workspace-panels/FileWorkspacePanel* | \
      wework/src/components/layout/workspace-panels/WorkspaceFilePreview* | \
      wework/src/components/layout/workspace-panels/WorkspaceFileTree* | \
      wework/src/components/layout/workspace-panels/WorkspaceTextFileEditor* | \
      wework/src/components/layout/workspace-panels/workspaceFileTypes* | \
      wework/src/components/chat/useDesktopMarkdownServices* | \
      wework/src/components/chat/FileChangesReviewPanel* | \
      wework/e2e/desktop/scenarios/local-file-preview.scenario.mjs)
      select_target "core:local-file-preview"
      select_target "core:office-file-preview"
      if [[ "$path" == wework/src/components/layout/workspace-panels/FileWorkspacePanel* || \
        "$path" == wework/src/components/layout/workspace-panels/WorkspaceFilePreview* || \
        "$path" == wework/src/components/layout/workspace-panels/workspaceFileTypes* || \
        "$path" == wework/src/components/chat/useDesktopMarkdownServices* ]]; then
        select_target "cloud:rendering-extensions"
      fi
      return
      ;;
    wework/e2e/desktop/scenarios/office-file-preview.scenario.mjs | \
      wework/e2e/desktop/modules/office-preview-fixtures.mjs | \
      wework/src/e2e/desktop-control-wheel*)
      select_target "core:office-file-preview"
      return
      ;;

    # Runtime queue orchestration has an independently bootstrapped checkpoint.
    wework/e2e/desktop/scenarios/workbench-control.scenario.mjs)
      select_catalog_path_targets "$path"
      return
      ;;
    wework/e2e/desktop/scenarios/runtime-task-queue.scenario.mjs)
      select_target "core:runtime-task-queue"
      return
      ;;
    wework/e2e/desktop/scenarios/codex-invalid-launch-cwd.scenario.mjs | \
    wework/e2e/desktop/modules/model-catalog-recovery.mjs)
      select_target "core:codex-invalid-launch-cwd"
      return
      ;;
    wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs)
      select_target "core:codex-notification-isolation"
      return
      ;;
    wework/e2e/desktop/scenarios/executor-stream-recovery.scenario.mjs|wework/e2e/desktop/scenarios/executor-retry-status.scenario.mjs)
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

    wework/e2e/desktop/scenarios/codex-native-catalog.scenario.mjs | \
      wework/e2e/desktop/scenarios/codex-catalog-context.mjs | \
      wework/e2e/desktop/scenarios/codex-catalog-reasoning.mjs)
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
      if [[ "$path" == wework/e2e/desktop/scenarios/* ]] && \
        select_catalog_path_targets "$path"; then
        return
      fi
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
      if ! select_catalog_path_targets "$path"; then
        select_all_desktop_suites
      fi
      return
      ;;
  esac
}
