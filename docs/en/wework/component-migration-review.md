---
sidebar_position: 31
---

# Wework component migration review

This record separates source review, running Story checks and native production-page acceptance. Migrated imports, type checks and a successful build do not establish page-by-page product acceptance. Evidence is a snapshot as of 2026-11-19; initial findings refer to the inspected revision, while source remediations are recorded separately.

## Verification baseline after main integration

Main was merged and conflicts resolved on 2026-11-19. Application and Storybook type checks pass. Wework lint reports zero errors and six warnings; the control audit covers 2223 production TypeScript files with zero outstanding migrations. The focused settings navigation and search tests pass (29 cases). The latest static Storybook build contains 209 examples and 54 Docs entries, including the new Composer Context Row.

Narrow settings now use the shared SettingsShell, and model connection forms use the public field density. Both changes were exercised in the packaged desktop review below. The isolated packaged workspace-tabs E2E passed with Redis 7, including the previously failing Issue description replacement. Builds, source audits and earlier screenshots do not replace native acceptance.

In an isolated macOS arm64 Electron package, the account menu opened Settings and all 19 entries were reachable at 480, 768 and 1440 CSS pixels. The content `clientWidth` ranges were 472–480, 520–528 and 1192–1200 CSS pixels respectively, and `scrollWidth` matched `clientWidth` in all 57 measurements. The entries were About, Appearance, Appshots, Archived Conversations, Browser, Computer Use, Connections, Context, Execution Environments, General, Git Hosting, Hooks, Keyboard Shortcuts, Models, Plugins, Proxy, Quick Phrases, Runtime, and Worktrees.

The narrow captures show shortcut titles, quick phrase row actions and execution environment buttons. Worktrees was still loading during capture and Runtime was disconnected from the cloud. The model settings E2E covered adding, editing and deleting a model connection.

A second isolated package opened the task, Record Issue, and Create task composers using a local project and found the Record Issue selector in the bottom toolbar. After the layout change, isolated source Electron displayed Record Issue and Create task at 1440×869 CSS pixels. Both selectors measured 28 CSS pixels high, showed the same project, and ended 11 CSS pixels above the editor. The packaged `collaboration-issue-task-discovery` E2E passed the selector placement and height comparison, draft recovery after switching projects, and task submission. The scenario used the real collaboration services and a test model service.

After adopting the shared ScrollArea, the new content wrapper no longer filled the task home viewport. The fixed homepage fills the workbench and the composer is horizontally centered with an 8 CSS pixel bottom gap in isolated Electron at 1440×900, 1024×768 and 768×680. At 1440 pixels wide, the composer is 736 CSS pixels wide and the four quick-start cards share one row.

The Collaboration Assistant notification prompt uses the shared compact icon button. In isolated Electron at 1440 and 1180 CSS pixels wide, the dismiss button measured 28 pixels high and sat at the top right of the prompt. The narrower panel placed both text actions on a second row, and pressing Dismiss hid the prompt.

Packaged core workflow captures also show the Cloud Work empty state, the system-drag popout composer, Issue details in the task side panel, the board Issue drawer, the task association dialog, and worktree creation progress. Review covered the visible region and its controls in each capture. Cloud Work was disconnected, and the association dialog was captured after an initial selection of a different project. The fixed package reopened Issue search when the current project was selected again, then loaded the newly linked Issue's details and activity.

The complete macOS arm64 packaged `core-task-flow` passed. The task association dialog recorded 125 frames during loading, filtering and scrolling. The dialog, search input and create button kept the same mounts, with a maximum change of 0 CSS pixels in position and size.

Isolated source Electron at 1440×900 CSS pixels covered the plugin marketplace, Applications, Scheduled, Assistant onboarding and home, the interaction inbox, the notification list, and notification settings. The onboarding action to chat and connect later opened Assistant home. The plugin marketplace showed local plugin entries alongside a remote catalog error. Applications, Scheduled and the inbox showed unconfigured or empty states. The visible inbox, notification list and notification settings containers showed no horizontal overflow at either 1440 or 768 CSS pixels wide. At 768 CSS pixels, expanding the sidebar opened Plugins, Applications, Scheduled, and Assistant. All four measured containers stayed inside the viewport without horizontal overflow. Plugin filters and search use two rows at 768 CSS pixels and one row at 1440 CSS pixels. The Scheduled list retains 20 CSS pixels of inner padding at both widths. Interactions for loaded plugin, application, and cloud states remain open.

The component library defines surfaces, sizes, radii, and interaction states for controls with the same role. Composer workspaces, collaboration projects, execution modes, and branches share the context trigger treatment. Ordinary text inputs, selects, and textareas use the same outlined field surface. Confirmation dialogs and footers in project, plugin, site, and device settings dialogs use the shared primary, secondary, and destructive button variants. Business code supplies labels, state, options, and callbacks. The ComposerContextRow Storybook example places three context controls side by side.

In isolated source Electron, the collaboration Create Task composer measured all three context controls at 28 CSS pixels with the same border, background, font weight, and corner radius. The project picker opened above its trigger when space allowed. Wework plugin creation, installation, and the install input measured 36 CSS pixels, with the shared disabled state for empty input. A populated Scheduled sidebar project row showed no overlapping grip icon.

## Scope and status

The static entry inventory scanned 3311 production source files and identified 234 source owners: 80 popup owners, 45 Pages, 76 dialogs/drawers, 25 panels and 8 registered surfaces. A source owner is a file-level ownership entry, not an independently accepted page. The list below covers only the 45 Page files, retaining shells, re-exports and delegated wrappers as source records. The initial12 entry gaps have been classified in the following audit.

All 45 Pages retain `review_status: source_reviewed_ui_not_reviewed`; none is relabeled as native acceptance. Of 34 initial source findings, 33 recorded source remediation; this final change only localizes the remaining HomePage copy. `fixed_source_pending_real_ui_review` means changed source awaiting real UI review.

Shell provider evidence includes `WorkbenchProvider`, `AppUpdateProvider`, `CloudConnectionProvider`, `AuthProvider`, `AppearanceProvider`, `AppPreferencesProvider`, `NotificationTaskSourceProvider`, `WorkspaceTabsProvider` and `RuntimeInteractionsProvider`. Presence in the shell does not establish an isolated Story's dependencies. Permission identifiers below are static clues, not permission assertions.

## Dynamic entry and unused implementation audit

This pass traces the12 unresolved entries from the initial inventory:5 dynamic routes,1 global overlay,1 conditional slot,1 hook-returned control,1 library showcase,1 unmounted placeholder and2 unused implementations. Static registrations establish ownership, not real UI acceptance. The unused task-create dialog and detail panel total1680 lines and have been removed. Shared data contracts moved to todoTypes.ts, with6 type consumers updated and no compatibility forwarding.

| Source owner                                                                          | Classification        | Entry or conclusion                                                                                        | Evidence                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wework/src/pages/HomePage.tsx`                                                       | Unmounted placeholder | No production import, JSX consumer, route or dynamic descriptor found                                      | [App.tsx](../../../wework/src/App.tsx) / [HomePage.tsx](../../../wework/src/pages/HomePage.tsx)                                                                                                                           |
| `wework/src/features/todo/TodoCreateDialog.tsx`                                       | Removed unused UI     | No render consumer; retained TodoDetailItem/TodoViewState in todoTypes.ts                                  | [todoTypes.ts](../../../wework/src/features/todo/todoTypes.ts)                                                                                                                                                            |
| `wework/src/features/todo/TodoDetailPanel.tsx`                                        | Removed unused UI     | No render consumer; retained TodoDetailItem/TodoViewState in todoTypes.ts                                  | [todoTypes.ts](../../../wework/src/features/todo/todoTypes.ts)                                                                                                                                                            |
| `wework/dsh/conversation-export/src/dialog.tsx`                                       | DSH overlay           | conversation-export.open → wework.shell.overlay                                                            | [client.js](../../../wework/dsh/conversation-export/client.js) / [vite.config.ts](../../../wework/vite.config.ts)                                                                                                         |
| `wework/dsh/ui-applications/src/SitesPage.tsx`                                        | DSH route             | /sites                                                                                                     | [client.js](../../../wework/dsh/ui-applications/client.js) / [route.tsx](../../../wework/dsh/ui-applications/src/route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                                            |
| `wework/dsh/ui-automations/src/AutomationsPage.tsx`                                   | DSH route             | /automations                                                                                               | [client.js](../../../wework/dsh/ui-automations/client.js) / [route.tsx](../../../wework/dsh/ui-automations/src/route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                                              |
| `wework/dsh/ui-cloud-work/src/CloudWorkPage.tsx`                                      | DSH route             | /cloud-work                                                                                                | [client.js](../../../wework/dsh/ui-cloud-work/client.js) / [route.tsx](../../../wework/dsh/ui-cloud-work/src/route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                                                |
| `wework/dsh/ui-git/src/environment-section.tsx`                                       | DSH slot              | wework.conversation.summary / git-summary; required wework.environment; workspace.isGitRepository != false | [client.js](../../../wework/dsh/ui-git/client.js) / [vite.config.ts](../../../wework/vite.config.ts)                                                                                                                      |
| `wework/dsh/ui-plugin-center/src/PluginCreatePage.tsx`                                | DSH route             | /plugins/create                                                                                            | [client.js](../../../wework/dsh/ui-plugin-center/client.js) / [create-route.tsx](../../../wework/dsh/ui-plugin-center/src/create-route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                            |
| `wework/dsh/ui-plugin-center/src/PluginManagementPage.tsx`                            | DSH route             | /plugins/manage                                                                                            | [client.js](../../../wework/dsh/ui-plugin-center/client.js) / [management-route.tsx](../../../wework/dsh/ui-plugin-center/src/management-route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                    |
| `packages/collaboration/src/project-assistant-status/ProjectAssistantStatusPanel.tsx` | Library showcase      | ProjectAssistantStatus.stories.tsx; no production mount found                                              | [index.ts](../../../packages/collaboration/src/project-assistant-status/index.ts) / [ProjectAssistantStatus.stories.tsx](../../../packages/collaboration/src/project-assistant-status/ProjectAssistantStatus.stories.tsx) |
| `packages/collaboration/src/project-board/useBoardTagFilter.tsx`                      | Hook-returned control | useBoardTagFilter().control                                                                                | [CloudTodoWorkspace.tsx](../../../wework/src/features/todo/CloudTodoWorkspace.tsx) / [ProjectBoardAdapter.tsx](../../../packages/collaboration/src/web-adapter/ProjectBoardAdapter.tsx)                                   |

## Source records for all 45 Pages

Review dimensions include public-control selection, button semantics, field density, destructive colors, duplicated ordinary controls and SDK CSS state contracts. No finding does not imply visual or behavioral acceptance. Entries below are statically resolved callers; actual navigation still requires authentication, device, connection and business permissions.

### 1. HomePage

[wework/src/pages/HomePage.tsx](../../../wework/src/pages/HomePage.tsx)

Source conclusion: Placeholder display only; its existing subtitle now uses one shared translation key. No new feature or route was introduced.

Remediation: The existing subtitle uses `common.homePage.workspaceComingSoon` in both locales, preserving placeholder meaning without adding functionality.

Entry/caller: no production import, render consumer or dynamic registration found. This is an unmounted placeholder source, not a reachable product page.

Dependencies/delegation: No explicit hook/permission clue; host/provider and data prerequisites still require resolution.

### 2. LoginPage

[wework/src/pages/LoginPage.tsx](../../../wework/src/pages/LoginPage.tsx)

Source conclusion: Login/admin password forms own fields and errors; the OIDC action explicitly uses button semantics. Child forms still require runtime review.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/App.tsx](../../../wework/src/App.tsx)

Dependencies/delegation: hooks: `useAuth`, `useTranslation`；Delegates: `AdminPasswordSetupForm`, `PasswordLoginForm`

### 3. OidcCallbackPage

[wework/src/pages/OidcCallbackPage.tsx](../../../wework/src/pages/OidcCallbackPage.tsx)

Source conclusion: OIDC progress display only. Authentication redirects are outside this visual finding.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/App.tsx](../../../wework/src/App.tsx)

Dependencies/delegation: hooks: `useAuth`, `useTranslation`

### 4. PopoutWorkbenchPage

[wework/src/pages/PopoutWorkbenchPage.tsx](../../../wework/src/pages/PopoutWorkbenchPage.tsx)

Source conclusion: Title actions have accessible names and explicit button types. Window drag-region behavior and full workbench remain native-host dependencies.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/App.tsx](../../../wework/src/App.tsx)

Dependencies/delegation: hooks: `useWorkbench`, `useTranslation`；Delegates: `SquarePen`, `DesktopWorkbenchMain`

### 5. ProcessExplorerPage

[wework/src/pages/ProcessExplorerPage.tsx](../../../wework/src/pages/ProcessExplorerPage.tsx)

Source conclusion: Binds ProcessExplorerView to host ports; controls, ordering and fields belong to that delegated view.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/App.tsx](../../../wework/src/App.tsx)

Dependencies/delegation: Delegates: `ProcessExplorerView`

### 6. WeworkAuthorizePage

[wework/src/pages/WeworkAuthorizePage.tsx](../../../wework/src/pages/WeworkAuthorizePage.tsx)

Source conclusion: Success/failure/expiry use semantic icons. Duplicated primary action recipes were removed; actual state layouts remain unverified.

Remediation: duplicated_button_recipe (original evidence line 115): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 137): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: [wework/src/App.tsx](../../../wework/src/App.tsx)

Dependencies/delegation: hooks: `useAuth`, `useTranslation`；Delegates: `CheckCircle2`, `XCircle`, `AlertCircle`

### 7. WorkbenchPage

[wework/src/pages/WorkbenchPage.tsx](../../../wework/src/pages/WorkbenchPage.tsx)

Source conclusion: Selects desktop/mobile layouts and binds the runtime; an adapter with no direct controls does not establish workbench acceptance.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/dsh/ui-core-apps/src/app-surface.tsx](../../../wework/dsh/ui-core-apps/src/app-surface.tsx)

Dependencies/delegation: hooks: `useWorkbench`；Delegates: `SystemDragBridge`, `DesktopWorkbenchLayout`, `TaskWorkbenchPage`, `WorkbenchPageLayout`, `MobileWorkbenchLayout`

### 8. WorkbenchErrorPage

[wework/src/components/common/WorkbenchErrorPage.tsx](../../../wework/src/components/common/WorkbenchErrorPage.tsx)

Source conclusion: The reload action uses the shared Button, explicit button semantics and a test ID. The error display contains no fields or deletion.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/main.tsx](../../../wework/src/main.tsx)；[wework/src/components/common/WorkbenchErrorBoundary.tsx](../../../wework/src/components/common/WorkbenchErrorBoundary.tsx)

Dependencies/delegation: hooks: `useTranslation`

### 9. AboutSettingsPage

[wework/src/components/settings/AboutSettingsPage.tsx](../../../wework/src/components/settings/AboutSettingsPage.tsx)

Source conclusion: Settings rows and switches are shared. The primary action recipe was normalized; update/rollback and external-link behavior still need host verification.

Remediation: duplicated_button_recipe (original evidence line 54): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/about`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `ReleaseRollbackSettings`, `ProgressBar`, `AboutLink`

### 10. AppshotsSettingsPage

[wework/src/components/settings/AppshotsSettingsPage.tsx](../../../wework/src/components/settings/AppshotsSettingsPage.tsx)

Source conclusion: Settings rows and switches are shared. Permission-settings button recipes were normalized; operating-system permission flows remain unverified.

Remediation: duplicated_button_recipe (original evidence line 86): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/appshots`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `ScanLine`, `KeyboardShortcut`

### 11. ArchivedConversationsSettingsPage

[wework/src/components/settings/ArchivedConversationsSettingsPage.tsx](../../../wework/src/components/settings/ArchivedConversationsSettingsPage.tsx)

Source conclusion: Filters/groups delegate to existing components. The existing destructive confirmation recipe was normalized; archive and local-session services remain dependencies.

Remediation: duplicated_button_recipe (original evidence line 305): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/archived-conversations`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `DialogSurface`, `SettingsPage`, `SettingsPageHeader`, `ArchivedConversationsFilters`, `ArchivedConversationGroups`, `DeleteArchivedConversationDialog`

### 12. BrowserHistoryPage

[wework/src/components/settings/BrowserHistoryPage.tsx](../../../wework/src/components/settings/BrowserHistoryPage.tsx)

Source conclusion: Search, checkbox and actions use shared controls. Local unstyled retry/delete recipes remain source-review candidates requiring rendered comparison.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/components/settings/BrowserSettingsPage.tsx](../../../wework/src/components/settings/BrowserSettingsPage.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `Globe`, `HistoryEntryFavicon`, `ActionMenu`, `History`, `ChevronDown`, `HistoryEntryRow`, `ClearBrowserDataDialog`, `TransientNotice`

### 13. BrowserSettingsPage

[wework/src/components/settings/BrowserSettingsPage.tsx](../../../wework/src/components/settings/BrowserSettingsPage.tsx)

Source conclusion: Settings rows, select and switch are shared. Clear-data uses destructive semantics; local management/reset recipes remain runtime-review candidates.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: `/settings/browser`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `BrowserHistoryPage`, `SettingsPage`, `SettingsPageHeader`, `History`, `FolderOpen`, `ClearBrowserDataDialog`

### 14. ComputerUseSettingsPage

[wework/src/components/settings/ComputerUseSettingsPage.tsx](../../../wework/src/components/settings/ComputerUseSettingsPage.tsx)

Source conclusion: Settings rows and switches are shared. Permission-action recipes were normalized; actual permission transitions require the native host.

Remediation: duplicated_button_recipe (original evidence line 80): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/computer-use`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `MonitorCog`

### 15. ConnectionsSettingsPage

[wework/src/components/settings/ConnectionsSettingsPage.tsx](../../../wework/src/components/settings/ConnectionsSettingsPage.tsx)

Source conclusion: Device action and icon recipes were normalized. Delegated connection/device services and production split-pane lifetime still need runtime review.

Remediation: duplicated_button_recipe (original evidence line 167): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 268): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 397): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 1159): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 1231): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: The desktop workbench mounts the connections settings shell when settings open. The core settings plugin registers `/settings/connections` and loads its device settings page inside the shell. [Route registration](../../../wework/dsh/ui-core-settings/client.js), [desktop workbench](../../../wework/src/components/layout/DesktopWorkbenchLayoutView.tsx), [core settings module](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useCloudConnection`, `useTranslation`；Permission-related identifiers (not authorization evidence): `isConnected`；Delegates: `Pencil`, `DeviceVersionBadge`, `StatusPill`, `DeviceSurfaceDeviceAction`, `ActionMenu`, `CloudDeviceRestartProgress`, `AlertCircle`, `Terminal`, `RemoteTerminal`, `ConfirmDeleteDeviceDialog`, `CloudDeviceConnectionInfoDialog`, `DeviceCard`, `Code2`, `SettingsPage`, `SettingsPageHeader`, `RemoteTaskAccessSetting`, `DshSettingsSectionSurface`, `CloudConnectionDialog`, `LogOut`, `CloudModelsSection`, `ConnectorConnectionsSection`, `DeviceSection`, `DeviceGitSyncSection`, `AddCloudDeviceDialog`, `WorkbenchCloudDeviceRestarts`, `DesktopTopBar`, `ArrowLeft`, `ExperimentalBadge`, `DshSettingsSurface`, `DshSlotSurface`

### 16. ContextSettingsPage

[wework/src/components/settings/ContextSettingsPage.tsx](../../../wework/src/components/settings/ContextSettingsPage.tsx)

Source conclusion: Duplicated save action recipes were normalized. Textarea density, preference persistence and local instruction files remain runtime dependencies.

Remediation: duplicated_button_recipe (original evidence line 243): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 281): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/personal/context`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `Terminal`, `CodexPersonalitySettings`, `Save`

### 17. ExecutionEnvironmentsSettingsPage

[wework/src/components/settings/ExecutionEnvironmentsSettingsPage.tsx](../../../wework/src/components/settings/ExecutionEnvironmentsSettingsPage.tsx)

Source conclusion: Node/Python actions use shared outline/ghost buttons. Runtime installation states and permissions remain unverified.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: `/settings/execution-environments`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `Box`, `FolderOpen`, `RotateCcw`, `RefreshCw`, `Download`

### 18. GeneralSettingsPage

[wework/src/components/settings/GeneralSettingsPage.tsx](../../../wework/src/components/settings/GeneralSettingsPage.tsx)

Source conclusion: Shared settings rows, selection and switches are reused. Import, shortcut recording and delegated behavior need rendered and native review.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: `/settings`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useCloudConnection`, `useWorkbench`, `useTranslation`, `useContext`；Permission-related identifiers (not authorization evidence): `isConnected`；Delegates: `SettingsPage`, `SettingsPageHeader`, `DefaultRunnerSetting`, `SettingsSegmentedControl`, `GeneralFixedWorkspaceTabs`, `DshSettingsSectionSurface`, `RuntimeConcurrencySettings`, `Bell`, `ReplyPredictionSettings`, `TelemetryCollectionNotice`, `KeyboardShortcut`, `Pencil`, `ExternalContentImportDialog`, `ConfirmDialog`

### 19. GitHostingSettingsPage

[wework/src/components/settings/GitHostingSettingsPage.tsx](../../../wework/src/components/settings/GitHostingSettingsPage.tsx)

Source conclusion: Git CLI actions retain local unstyled recipes as review candidates; switches are shared. Real CLI/authentication services remain dependencies.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/dsh/ui-git/src/settings-page.tsx](../../../wework/dsh/ui-git/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `RefreshCw`, `GitBranch`

### 20. HarnessSettingsPage

[wework/src/components/settings/HarnessSettingsPage.tsx](../../../wework/src/components/settings/HarnessSettingsPage.tsx)

Source conclusion: Tool expansion, enablement and permission selection have distinct semantics. Executable-picker action recipe was normalized; native selection remains unverified.

Remediation: duplicated_button_recipe (original evidence line 309): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/harnesses`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `ExperimentalBadge`, `SquareTerminal`, `ChevronDown`, `FolderOpen`, `RotateCcw`

### 21. KeyboardShortcutsSettingsPage

[wework/src/components/settings/KeyboardShortcutsSettingsPage.tsx](../../../wework/src/components/settings/KeyboardShortcutsSettingsPage.tsx)

Source conclusion: Search uses compact TextField and clearing uses DeleteIconButton. Shortcut recording and mobile touch-target size require runtime verification.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: `/settings/personal/keyboard-shortcuts`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `KeybindingPart`, `CornerDownLeft`, `SettingsPage`, `SettingsPageHeader`, `KeybindingPill`, `RotateCcw`

### 22. MobileSettingsPage

[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)

Source conclusion: Mobile menu/back controls declare 44px or 56px heights. Repeated navigation markup and actual device interaction remain review boundaries.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: The mobile workbench mounts this page for `/settings` and its subpaths. The applications page also mounts it when settings open in its mobile layout. [Mobile workbench](../../../wework/src/components/layout/MobileWorkbenchLayout.tsx), [settings path matching](../../../wework/src/lib/navigation.ts), [applications page](../../../wework/dsh/ui-applications/src/SitesPage.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `ArrowLeft`, `DshSettingsSurface`, `ConnectionsDeviceSettingsPage`, `QuickPhrasesSettingsPage`, `RuntimeSettingsPage`, `GeneralSettingsPage`, `AppearanceSettingsPage`, `ContextSettingsPage`, `AboutSettingsPage`, `ArchivedConversationsSettingsPage`, `ExperimentalBadge`, `HarnessSettingsPage`, `PluginSettingsPage`, `SlidersHorizontal`, `ChevronRight`, `Palette`, `Terminal`, `UserRound`, `Server`, `MessageSquareText`, `ModelSettingsPage`, `Plug`, `Globe2`, `Archive`, `Package`

### 23. ModelSettingsPage

[wework/src/components/settings/ModelSettingsPage.tsx](../../../wework/src/components/settings/ModelSettingsPage.tsx)

Source conclusion: Model selection uses shared controls. Action/icon recipes were normalized; hidden file import remains a valid native integration boundary.

Remediation: duplicated_button_recipe (original evidence line 206): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 751): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 900): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/personal/models`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useCloudConnection`, `useTranslation`；Permission-related identifiers (not authorization evidence): `isConnected`；Delegates: `CodexOfficialModelsSection`, `LocalCodexModelRow`, `ChevronDown`, `ConfirmDialog`, `SettingsPage`, `SettingsPageHeader`, `CodexAuthSettingsSection`, `LocalCodexSubscriptionToggle`, `DisconnectedCloudCodexSyncSection`, `ProviderSettingsSection`, `CloudModelsSection`, `DisconnectedCloudModelsSection`, `RefreshCw`, `ShieldCheck`, `Upload`, `AlertCircle`

### 24. PluginSettingsPage

[wework/src/components/settings/PluginSettingsPage.tsx](../../../wework/src/components/settings/PluginSettingsPage.tsx)

Source conclusion: Delegates to shared settings groups, rows and switches. Loading/failure states require real plugin ports.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: `/settings/plugins`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `Package`, `AlertCircle`

### 25. ProxySettingsPage

[wework/src/components/settings/ProxySettingsPage.tsx](../../../wework/src/components/settings/ProxySettingsPage.tsx)

Source conclusion: Proxy mode uses RadioGroup. Save/restart recipes were normalized; restart and real proxy connectivity remain unverified.

Remediation: duplicated_button_recipe (original evidence line 342): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 363): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 506): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/personal/proxy`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useCloudConnection`, `useTranslation`；Permission-related identifiers (not authorization evidence): `isConnected`；Delegates: `Laptop`, `RadioGroup`, `Radio`, `AlertCircle`, `SettingsPage`, `SettingsPageHeader`, `Network`, `RefreshCw`, `ShieldCheck`

### 26. QuickPhrasesSettingsPage

[wework/src/components/settings/QuickPhrasesSettingsPage.tsx](../../../wework/src/components/settings/QuickPhrasesSettingsPage.tsx)

Source conclusion: SettingsPage wraps QuickPhrasesEditor. Fields, sorting and deletion must be reviewed in the actual editor.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: `/settings/personal/quick-phrases`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `QuickPhrasesEditor`

### 27. RuntimeSettingsPage

[wework/src/components/settings/RuntimeSettingsPage.tsx](../../../wework/src/components/settings/RuntimeSettingsPage.tsx)

Source conclusion: Create/save recipes were normalized. Subsequent Runtime fixture review covers labeled field density and list feedback, but not real executors or cloud mutations.

Remediation: duplicated_button_recipe (original evidence line 139): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 286): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/personal/runtimes`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `CloudTodoModal`, `LoaderCircle`

### 28. WorktreesSettingsPage

[wework/src/components/settings/WorktreesSettingsPage.tsx](../../../wework/src/components/settings/WorktreesSettingsPage.tsx)

Source conclusion: Cleanup confirmation keeps destructive semantics with normalized recipe. Worktree row actions and restore behavior require runtime/service verification.

Remediation: duplicated_button_recipe (original evidence line 607): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: [wework/dsh/ui-git/src/settings-page.tsx](../../../wework/dsh/ui-git/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `RefreshCw`, `WorktreeRow`, `CircleCheck`, `ConfirmDialog`, `DialogSurface`

### 29. AppearanceSettingsPage

[wework/src/features/appearance/AppearanceSettingsPage.tsx](../../../wework/src/features/appearance/AppearanceSettingsPage.tsx)

Source conclusion: Font fields use compact density; sliders and switches are shared. Reset/background action recipes were normalized; native background selection remains unverified.

Remediation: duplicated_button_recipe (original evidence line 225): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 418): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/appearance`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `RotateCcw`, `RangeSlider`, `WorkbenchBackgroundPreview`, `Image`, `FontSizeControl`

### 30. AutomationsPage

[wework/src/features/automations/AutomationsPage.tsx](../../../wework/src/features/automations/AutomationsPage.tsx)

Source conclusion: Composes list/detail workspaces, ConfirmDialog and MobileDrawer. Menu declares 44px; detail retry styling and real automation execution remain review boundaries.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/features/todo/StandInConnectionSettings.tsx](../../../wework/src/features/todo/StandInConnectionSettings.tsx)；[wework/src/features/todo/StandInScheduleDialog.tsx](../../../wework/src/features/todo/StandInScheduleDialog.tsx)

Dependencies/delegation: hooks: `useAuth`, `useWorkbench`, `useTranslation`；Permission-related identifiers (not authorization evidence): `userId`；Delegates: `MobileSettingsPage`, `ConnectionsSettingsPage`, `ConfirmDialog`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `DesktopCollapsedSidebarToggle`, `AutomationListPane`, `AutomationDetailWorkspace`, `AutomationEmptyState`, `WorkbenchSearchDialog`

### 31. HooksSettingsPage

[wework/src/features/hooks/HooksSettingsPage.tsx](../../../wework/src/features/hooks/HooksSettingsPage.tsx)

Source conclusion: Import/create semantics are explicit. Create action recipe was normalized; HookEditorDialog owns detailed fields and deletion.

Remediation: duplicated_button_recipe (original evidence line 38): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: `/settings/hooks`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

Dependencies/delegation: hooks: `useTranslation`；Delegates: `SettingsPage`, `SettingsPageHeader`, `Upload`, `RefreshCw`, `HookListItem`, `HookEditorDialog`

### 32. RuntimeInteractionsPage

[wework/src/features/notifications/RuntimeInteractionsPage.tsx](../../../wework/src/features/notifications/RuntimeInteractionsPage.tsx)

Source conclusion: List, clear, history and back actions use shared behavior with mobile sizing. Collapsible is shared; embedded notifications require permissions and real data.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/App.tsx](../../../wework/src/App.tsx)；[wework/src/features/notifications/runtimeInteractionsProvider.fixtures.tsx](../../../wework/src/features/notifications/runtimeInteractionsProvider.fixtures.tsx)

Dependencies/delegation: hooks: `useTranslation`；Permission-related identifiers (not authorization evidence): `userId`；Delegates: `RefreshCw`, `InteractionDraftRecovery`, `IssueWaitingTime`, `InteractionTime`, `CollapsibleRoot`, `CollapsibleTrigger`, `CollapsiblePanel`, `ArrowLeft`, `ArrowUpRight`, `WorkbenchErrorBoundary`, `NotificationEntitySurface`

### 33. StandInOverviewPage

[wework/src/features/todo/StandInOverviewPage.tsx](../../../wework/src/features/todo/StandInOverviewPage.tsx)

Source conclusion: Delegates roles, configuration and details to business components. Action sizes are declared; local role-tab styling and actual role flows remain unverified.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/src/features/todo/PersonalStandInWorkspace.tsx](../../../wework/src/features/todo/PersonalStandInWorkspace.tsx)

Dependencies/delegation: hooks: `useTranslation`, `useContext`；Permission-related identifiers (not authorization evidence): `userId`, `isConnected`, `readOnly`；Delegates: `StandInProposalCard`, `StandInSettingsEntry`, `UserRound`, `StandInIcon`, `Tooltip`, `SlidersHorizontal`, `StandInConversation`, `StandInDetailsPopover`, `TemporaryChatPanel`, `StandInScheduleDialog`, `StandInReviewDialog`, `StandInWorkList`, `StandInProcessingNotice`, `DialogSurface`, `StandInMemoryPanel`, `StandInPrimaryProfile`, `StandInSettingsPage`, `StandInOnboarding`

### 34. StandInSettingsPage

[wework/src/features/todo/StandInSettingsPage.tsx](../../../wework/src/features/todo/StandInSettingsPage.tsx)

Source conclusion: Final role deletion now uses the shared destructive variant, matching its entry action. Pending guards and permissions remain owned by existing handlers.

Remediation: duplicated_button_recipe (original evidence line 837): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. destructive_confirmation_variant (original evidence line 837): fixed_source_pending_real_ui_review; Shared destructive/destructive-ghost variants; original handlers, permissions and pending guard unchanged..

Entry/caller: [wework/src/features/todo/StandInOverviewPage.tsx](../../../wework/src/features/todo/StandInOverviewPage.tsx)；[wework/src/features/todo/StandInPopover.tsx](../../../wework/src/features/todo/StandInPopover.tsx)

Dependencies/delegation: hooks: `useTranslation`；Permission-related identifiers (not authorization evidence): `userId`；Delegates: `StandInSettingsEditor`, `DialogSurface`, `StandInSettingsHeader`, `StandInProjectSetup`, `StandInRequirements`, `StandInSettingsEntry`, `Folder`, `StandInConnectionSettings`, `StandInComposer`, `StandInSettingsError`, `ConfirmDialog`, `StandInSettingsActions`

### 35. SitesPage

[wework/dsh/ui-applications/src/SitesPage.tsx](../../../wework/dsh/ui-applications/src/SitesPage.tsx)

Source conclusion: Sites shell delegates to SitesWorkspace/marketplace and workbench navigation. Mobile menu declares 44px; editors/cards are not accepted by shell inspection.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: DSH route `/sites`, registered by [client.js](../../../wework/dsh/ui-applications/client.js) and mounted through [route](../../../wework/dsh/ui-applications/src/route.tsx); see the [Vite entry mapping](../../../wework/vite.config.ts).

Dependencies/delegation: hooks: `useAuth`, `useCloudConnection`, `useWorkbench`, `useTranslation`；Permission-related identifiers (not authorization evidence): `isConnected`；Delegates: `MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopWindowControls`, `DesktopCollapsedSidebarToggle`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `SitesWorkspace`, `SmartAppsMarketplacePage`, `WorkbenchSearchDialog`

### 36. SmartAppsMarketplacePage

[wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx](../../../wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx)

Source conclusion: Import/install/publish use shared actions and selects. Duplicated visibility/access action recipes were normalized; real application permissions remain unverified.

Remediation: duplicated_button_recipe (original evidence line 1456): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density.. duplicated_button_recipe (original evidence line 2070): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: The applications page at `/sites` mounts this component through the Smart Apps tab in `SitesWorkspace`. The marketplace is the default view and `view=owned` displays owned apps. [Applications page caller](../../../wework/dsh/ui-applications/src/SitesPage.tsx), [Smart Apps tab panel](../../../wework/src/components/sites/SitesWorkspace.tsx)

Dependencies/delegation: hooks: `useTranslation`；Permission-related identifiers (not authorization evidence): `accessRole`；Delegates: `Upload`, `CirclePlus`, `FolderOpen`, `Download`, `ApplicationContextToolbar`, `SmartAppsSectionNav`, `CheckCircle2`, `EmptyState`, `Box`, `PackageCheck`, `SmartAppCard`, `Play`, `ActionMenu`, `SmartAppDetails`, `HarnessAppInstallDialog`, `SmartAppPublishDialog`, `SmartAppShareDialog`, `SmartAppDevelopmentDialog`, `SmartAppPluginDialog`, `SmartAppRemoveLocalDialog`, `VisibilityIcon`, `Puzzle`, `DialogSurface`, `Boxes`, `ShieldCheck`, `PackageOpen`, `CalendarDays`, `ReactMarkdown`, `TargetPicker`, `SmartAppFilePicker`

### 37. AutomationsPage

[wework/dsh/ui-automations/src/AutomationsPage.tsx](../../../wework/dsh/ui-automations/src/AutomationsPage.tsx)

Source conclusion: Re-exports the feature AutomationsPage. It is a source entry, not a second independently accepted UI.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: DSH route `/automations`, registered by [client.js](../../../wework/dsh/ui-automations/client.js) and mounted through [route](../../../wework/dsh/ui-automations/src/route.tsx); see the [Vite entry mapping](../../../wework/vite.config.ts).

Dependencies/delegation: No explicit hook/permission clue; host/provider and data prerequisites still require resolution.

### 38. CloudWorkPage

[wework/dsh/ui-cloud-work/src/CloudWorkPage.tsx](../../../wework/dsh/ui-cloud-work/src/CloudWorkPage.tsx)

Source conclusion: Add-device recipe was normalized. Responsive minimum heights on outline actions are layout constraints, not independently proven defects.

Remediation: duplicated_button_recipe (original evidence line 275): fixed_source_pending_real_ui_review; Removed local recipe; common Button or IconButton owns style/density..

Entry/caller: DSH route `/cloud-work`, registered by [client.js](../../../wework/dsh/ui-cloud-work/client.js) and mounted through [route](../../../wework/dsh/ui-cloud-work/src/route.tsx); see the [Vite entry mapping](../../../wework/vite.config.ts).

Dependencies/delegation: hooks: `useAuth`, `useWorkbench`, `useTranslation`；Delegates: `DesktopCollapsedSidebarToggle`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `Settings`, `DeviceSection`, `FolderGit2`, `WorkbenchSearchDialog`

### 39. PluginCreatePage

[wework/dsh/ui-plugin-center/src/PluginCreatePage.tsx](../../../wework/dsh/ui-plugin-center/src/PluginCreatePage.tsx)

Source conclusion: Workbench shell delegates the creation form to PluginCreateWorkspace. Mobile menu declares 44px; creation flow still needs real ports.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: DSH route `/plugins/create`, registered by [client.js](../../../wework/dsh/ui-plugin-center/client.js) and mounted through [route](../../../wework/dsh/ui-plugin-center/src/create-route.tsx); see the [Vite entry mapping](../../../wework/vite.config.ts).

Dependencies/delegation: hooks: `useAuth`, `useWorkbench`, `useTranslation`；Delegates: `MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `PluginCreateWorkspace`, `DesktopWindowControls`, `WorkbenchSearchDialog`

### 40. PluginManagementPage

[wework/dsh/ui-plugin-center/src/PluginManagementPage.tsx](../../../wework/dsh/ui-plugin-center/src/PluginManagementPage.tsx)

Source conclusion: Workbench shell delegates management to PluginManagementWorkspace. Mobile menu declares 44px; operation and failure states remain unverified.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: DSH route `/plugins/manage`, registered by [client.js](../../../wework/dsh/ui-plugin-center/client.js) and mounted through [route](../../../wework/dsh/ui-plugin-center/src/management-route.tsx); see the [Vite entry mapping](../../../wework/vite.config.ts).

Dependencies/delegation: hooks: `useAuth`, `useCloudConnection`, `useWorkbench`, `useTranslation`；Delegates: `MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopWindowControls`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `PluginManagementWorkspace`, `WorkbenchSearchDialog`

### 41. PluginsPage

[wework/dsh/ui-plugin-center/src/PluginsPage.tsx](../../../wework/dsh/ui-plugin-center/src/PluginsPage.tsx)

Source conclusion: Lazy workspace shell with a 44px mobile menu. Suspense, failures and recovery remain delegated runtime review.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [wework/dsh/ui-plugin-center/src/catalog-route.tsx](../../../wework/dsh/ui-plugin-center/src/catalog-route.tsx)

Dependencies/delegation: hooks: `useAuth`, `useCloudConnection`, `useWorkbench`, `useTranslation`；Delegates: `MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopCollapsedSidebarToggle`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `Suspense`, `PluginsWorkspaceRouteFallback`, `DesktopWindowControls`, `PluginsWorkspace`, `WorkbenchSearchDialog`

### 42. MilestonesPage

[packages/collaboration/src/milestones/MilestonesPage.tsx](../../../packages/collaboration/src/milestones/MilestonesPage.tsx)

Source conclusion: Milestone actions now use shared variants and destructive confirmation. MilestoneForm and permission-gated mutation still require runtime review.

Remediation: destructive_confirmation_variant (original evidence line 209): fixed_source_pending_real_ui_review; Shared destructive/destructive-ghost variants; original handlers, permissions and pending guard unchanged..

Entry/caller: [packages/collaboration/src/CollaborationApp.tsx](../../../packages/collaboration/src/CollaborationApp.tsx)

Dependencies/delegation: Permission-related identifiers (not authorization evidence): `canManage`；Delegates: `MilestoneForm`, `Flag`, `MilestoneProgress`, `ProgressBar`

### 43. ResourceCatalogPage

[packages/collaboration/src/platform/ResourceCatalogPage.tsx](../../../packages/collaboration/src/platform/ResourceCatalogPage.tsx)

Source conclusion: Resource search and delete icons are shared. Agent/team confirmations now use destructive variants; actual ownership and service mutations remain unverified.

Remediation: destructive_confirmation_variant (original evidence line 927): fixed_source_pending_real_ui_review; Shared destructive/destructive-ghost variants; original handlers, permissions and pending guard unchanged..

Entry/caller: [packages/collaboration/src/platform/CollaborationPlatformApp.tsx](../../../packages/collaboration/src/platform/CollaborationPlatformApp.tsx)

Dependencies/delegation: Permission-related identifiers (not authorization evidence): `currentUserId`；Delegates: `UserRound`, `UsersRound`, `PageIcon`, `DeviceCatalogFeedback`, `Monitor`, `DeviceLastSeen`, `Tooltip`, `Settings`, `ResourceDestinationDialog`, `ResourceBindingDialog`, `DeviceDeleteDialog`, `DialogSurface`

### 44. ProjectSettingsPage

[packages/collaboration/src/project-manage/ProjectSettingsPage.tsx](../../../packages/collaboration/src/project-manage/ProjectSettingsPage.tsx)

Source conclusion: Generic project-settings layout accepts actions/children. Width is a layout concern; the wrapper does not establish child-field acceptance.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [packages/collaboration/src/project-manage/ProjectAutomaticProcessing.tsx](../../../packages/collaboration/src/project-manage/ProjectAutomaticProcessing.tsx)；[packages/collaboration/src/templates/ProjectTemplateSettings.tsx](../../../packages/collaboration/src/templates/ProjectTemplateSettings.tsx)

Dependencies/delegation: No explicit hook/permission clue; host/provider and data prerequisites still require resolution.

### 45. CollaborationTemplatePage

[packages/collaboration/src/templates/CollaborationTemplatePage.tsx](../../../packages/collaboration/src/templates/CollaborationTemplatePage.tsx)

Source conclusion: Shared search and dialog business components compose the template surface. CSS open-state and nested inline-step contracts were separately corrected; store/import and full page remain runtime boundaries.

Remediation: no separately confirmed source defect recorded for this file; delegated boundaries are not accepted by implication.

Entry/caller: [packages/collaboration/src/platform/CollaborationPlatformApp.tsx](../../../packages/collaboration/src/platform/CollaborationPlatformApp.tsx)；[packages/collaboration/src/templates/GroupTemplateCreator.tsx](../../../packages/collaboration/src/templates/GroupTemplateCreator.tsx)；[packages/collaboration/src/templates/ProjectTemplateSettings.tsx](../../../packages/collaboration/src/templates/ProjectTemplateSettings.tsx)；[packages/collaboration/src/templates/TemplateCreateSection.tsx](../../../packages/collaboration/src/templates/TemplateCreateSection.tsx)

Dependencies/delegation: Permission-related identifiers (not authorization evidence): `isConnected`；Delegates: `ScopedCollaborationTemplatePage`, `RefreshCw`, `Layers3`, `TemplatePanel`, `TemplatePreview`, `TemplateImportDialog`

## Cross-interface consistency coverage matrix

Same-purpose controls require a shared implementation, an explicit recipe and observed cross-surface behavior. Forms and toolbars may use distinct declared densities, not page-specific recipes. This post-main matrix is incomplete: site/owner counts come from named JSX imports and aliases, include primitive composition and are not page or acceptance counts. One consumer passing does not accept the rest.

| Family                      | Surface scope                                              | Consistency contract                                                                                                                               | Evidence and remaining gap                                                                                  | Sites / source owners                                                                      |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Action buttons              | Toolbars, forms, lists, cards                              | Same semantics use the same variant; inverse-neutral primary actions; shared API sizes and mobile44px; distinguish structural clickable containers | Recipes and initial native evidence exist; unclassified unstyled callers are not automatically consistent   | Button: 1770 / 521; IconButton: 6 / 6                                                      |
| Composer                    | Task, record Issue, create task                            | Shared surface/toolbar/project picker; desktop28px, mobile44px; consistent draft/disabled behavior                                                 | Task home and both Collaboration layouts reviewed; Collaboration drafts and submission passed packaged E2E                  | ProjectChatComposerSurface: 1 / 1; ComposerProjectSelector: 2 / 2                          |
| Deletion                    | Quick phrases, Runtime, settings/list/card                 | Resource deletion uses danger; queue cancellation remains a separate operation; shared disabled/pending behavior                                   | Quick phrase native appearance/cancel focus observed; Runtime cloud CRUD and cross-theme comparison pending | DeleteIconButton: 21 / 18                                                                  |
| Single selection            | Forms, settings rows, composer toolbar                     | Forms default/outline36px; toolbars dense/plain28px; mobile44px minimum; stable names                                                              | Story measurements exist; native model32px fields require role-based verification                           | SelectField: 21 / 16; MenuSelect: 9 / 3; ComposerProjectSelector: 2 / 2                    |
| Searchable selection        | People/collaborators, projects, branches, automation tasks | Shared search/selection, disabled/empty/error/retry and focus return; stable business IDs                                                          | Story interactions reviewed; Collaboration project selection passed packaged E2E, with other native entries open                                   | SearchableSelect: 30 / 28                                                                  |
| Text fields                 | Settings, configuration, create/edit forms                 | Field label/description/error; desktop36px, mobile44px; specialized editors retain their engine                                                    | Native Issue replacement fails with old text appended; root cause unresolved, assertions preserved          | TextField: 200 / 113; Textarea: 53 / 40                                                    |
| Boolean/exclusive selection | Settings, automation, model permissions                    | Shared checked/disabled semantics and targets, not visual checks alone; business owns selection constraints                                        | Weekday Stories exercised; post-merge assistant choices require native verification                         | Checkbox: 49 / 34; Switch: 8 / 7; Radio: 18 / 15; RadioGroup: 14 / 14                      |
| Menus/popups                | Sidebar, cards, toolbar, settings                          | Shared density28/32/36px and mobile44px; SDK owns keyboard/position/dismissal/focus                                                                | Component measurements exist; native entry reachability and state coverage incomplete                       | ActionMenu: 45 / 37; Popover: 41 / 35                                                      |
| Dialogs                     | Create, edit, delete confirmation, embedded steps          | One focus/dismissal owner; InlinePanel for embedded steps; business owns pending cancellation                                                      | Story and quick phrase native focus evidence only; other pages cannot inherit acceptance                    | DialogSurface: 132 / 117; ConfirmDialog: 33 / 30                                           |
| Reorder/transfer            | Queue, sidebar, statuses, Issue board                      | SDK reorder/transfer; preserve ownership; cancel without save and rollback failures                                                                | Component contracts passed; related post-merge native E2E incomplete                                        | SortableRoot: 3 / 3                                                                        |
| Panes/layout                | Workbench, experience, shared settings shell               | SDK interaction plus business persistence; consistent keyboard/cancel/unmount; retain narrow-screen entries                                        | Confirmed480px settings sidebar crowding; fix the shared layout, not individual pages                       | Resizable: 2 / 2; ResizableHandle: 3 / 3                                                   |
| Navigation/disclosure       | App/page tabs, exclusive settings, wait conditions         | Shared selected/focus recipes and SDK keyboard/disclosure state; no parallel native details handlers                                               | New main wait-condition control migrated; native cross-page state/keyboard checks pending                   | TabsRoot: 13 / 12; SegmentedControl: 2 / 2; CollapsibleRoot: 32 / 29                       |
| Scroll/tree                 | Files, settings navigation, conversation/long lists        | Shared scroll/tree behavior; preserve data/virtualization ownership and independent focus/selection/filter                                         | 1000-item Story checked; native filesystem/navigation/list coverage incomplete                              | ScrollArea: 4 / 4; VirtualTree: 3 / 3                                                      |
| Feedback                    | Notices, errors/progress, icon hints, previews             | Shared semantic colors, names, dismissal/persistence and theme; no page-specific replacement controls                                              | Toast theme/placement Story evidence exists; native feedback/contrast/recovery coverage incomplete          | Toast: 2 / 2; ProgressBar: 3 / 3; ProgressRing: 4 / 4; Tooltip: 102 / 57; HoverCard: 8 / 7 |

## Actual runtime observations: 24 records

These observations use production-component Stories in the Wework built-in browser, primarily at 784×526, zh-CN, light theme. Viewport helpers additionally measured 360/768/1280 widths. Twenty-four records include repeated Stories before/after changes or in different states; they are neither 24 distinct pages nor acceptance of all 234 owners. Recorded synthetic keyboard events do not establish native keyboard, Tab or IME behavior.

### 1. `patterns-composercomparison--three-production-flows`

Observed: Three visible forms 744x98; all visible toolbar controls 28px; no horizontal overflow; record project End/Enter commits example-1 and returns trigger focus; submitting text invokes local output then clears draft and disables empty submit; no new getAppPreferences rejection (count remains 8)

Limits: Local catalog/submission ports; no native desktop/real transport; no screenshot or native Tab

### 2. `controls-resizable--controlled-commit`

Observed: ArrowRight changes35/65 to36/64 and commits; End respects70/30 limit; Home respects20/80 limit; ARIA value agrees with state; no panel content overflow

Limits: Shared control; production split-session/portal lifetime still not browser reviewed

### 3. `controls-toast--persistent-action-notice`

Observed: 448px anchor ->416px notice (16px gutters), scrollWidth==clientWidth414; long text wraps; action increments once, preserves notice and clear count0; action retains focus; SDK anchor-width provided416px

Limits: After measurement set SDK sideOffset0 to preserve112px top; final vertical position needs fresh check

### 4. `patterns-inlinepanel--template-inline-step`

Observed: One dialog while inline step open; Escape closes step only and restores its trigger; reopen preserves draft; second Escape closes owner and restores outside opener

Limits: No additional per-record limit was recorded; local Story data and non-native acceptance limits still apply.

### 5. `patterns-inlinepanel--pending-step`

Observed: Escape leaves pending inline step and owner present; cancel disabled; dialog count1

Limits: No additional per-record limit was recorded; local Story data and non-native acceptance limits still apply.

### 6. `pages-runtimesettings--ready / --loading / --delete-pending`

Observed: Create dialog from existing public service ports; name submit creates second real row and restores New Runtime focus. Actual row delete controls32x32,transparent, rgb220/38/38, no page overflow. Pending delete aria-busy=true/disabled/spinner,row retained until fixture resolves; after resolution row removed and public result correct. Initial list hold incorrectly showed empty text; create fields mixed36px text input and28px plain unlabeled selectors.

Finding at that revision (later checks are separate): Initial loading/error state and form field role/density remediation delegated to composer_migration; not accepted until fresh review

Limits: In-memory ports, no real executor/cloud mutation; create dialog normal state reviewed before requested field remediation

### 7. `pages-runtimesettings (fresh after Field and loading fix)`

Observed: Real create fields name/device/model all labeled36px,480px wide,1px border,no dialog overflow at784px. Initial list hold shows role=status Loading, no false empty text, Create stays enabled. First-failed list renders independent alert and Retry; actual Retry restores populated row and clears error.

Limits: Public in-memory service ports only

### 8. `patterns-viewportreview--production-surfaces (Runtime ready)`

Observed: Three isolated iframe viewports measured exactly360/768/1280px. No document horizontal overflow in any. Real DeleteIconButton44x44 at360,32x32 at768/1280; identical rgb220/38/38 color. Full page centered at1280 and wraps header/row at360.

Limits: DOM geometry/state review; outer browser784px clips wide review canvas, no screenshot/composition approval for native full-window.

### 9. `patterns-viewportreview--production-surfaces (Composer)`

Observed: Independent viewports360 and1280 showed all3 production forms equal per width (320x210 at360,392x130 in3-column1280) with44px/28px toolbar actions respectively and no horizontal overflow. A768 sibling iframe failed dynamic import despite resource status200; source module error retained as dev-preview limitation. Review helper simplified to one live iframe to reduce resource usage and preserve same draft on resizing. Fresh768 one-frame review succeeded:3 forms728x98,no document/form overflow,no module error.

Limits: Multi-iframe import error root cause not proven; no claim it was a production component defect or fixed by generic cache changes.

### 10. `patterns-viewportreview--production-surfaces`

Observed: Single iframe Composer record draft 跨视口保留的草稿 remains unchanged after resizing 768→360→1280. 360 forms320x210 and44px actions;1280forms392x130 and28px actions; no document/form overflow.

Limits: Local preview ports, no native transport or IME.

### 11. `business-conversationqueue--mixed-ownership`

Observed: Space then ArrowDown previews sending,two,server,one,failed while saved state remains sending,one,server,two,failed. Space commits sending,two,server,one,failed. Focus remains source handle; no document overflow.

Limits: Browser keyboard synthetic events; pointer drag not exercised.

### 12. `controls-sortable--production-board-states`

Observed: Space/End previews Open at final position; Escape restores original order and source focus. Repeating Space/End/Space commits In progress,Done,Open with focus remaining Open. No document overflow.

Limits: Local state persistence only, no cloud save.

### 13. `business-taskdescriptioneditor--empty`

Observed: Filling actual contenteditable with 统一组件说明 updates production editor and expanded Markdown output identically; no document overflow.

Limits: Slash printable press did not insert a character in browser tool; filling slash alone does not prove actual key-triggered slash menu. Native IME/selection/clipboard not verified.

### 14. `business-planningdraganddrop--persist-failure`

Observed: Actual keyboard pickup,ArrowRight,drop surfaces save error 保存失败示例：保留原数据; card status remains待开始 and column pending; tags intact.

Limits: Failure fixture; native/backend writes not exercised.

### 15. `business-branchpicker--retry-directory-failure`

Observed: Opening selector exposes directory failure; Retry replaces error with3options; ArrowDown/Enter selects main, closes popup and returns focus to originaltrigger; no overflow.

Limits: Synthetic keyboard, local list port.

### 16. `controls-virtualtree--reveal-distant-item`

Observed: Production static Story reveals item900 of1000, only15treeitems mounted; click selects src/file-900; ArrowDown moves focus901 while preserving selection900; no overflow.

Limits: Story data, native filesystem integration not exercised.

### 17. `patterns-composercomparison--three-production-flows`

Observed: Production built static preview6007 loads all three actual chains; visibleforms all744x98; no horizontal overflow or failed resource response. Storybook hidden error template display none.

Limits: Static build before latest Transfer focus/platform source changes; local ports, no native application acceptance.

### 18. Board move focus closure

The production static build retains the card button focus during pickup and ArrowRight, with aria-pressed=true. Dropping saves In progress and retains focus on its replacement button. SDK keepFocus closes the earlier BODY-focus defect, verified with a browser predicate combining saved status and matching focus. Adapter contracts separately cover external focus during pending persistence; native transport remains unverified.

### 19. Read-only board

Space, ArrowRight, Space leave Pending unchanged, expose no aria-pressed state and do not invoke open. A local fixture does not prove server permission enforcement.

### 20. Weekday menu semantics

Multiple selection exposes menuitemcheckbox and aria-checked. Choosing Tuesday produces1,2 and keeps the menu open; Escape closes it. Single selection exposes menuitemradio; choosing Tuesday produces2, closes and restores trigger focus. Multiple selection remains1,2. Scheduler persistence was not exercised.

### 21. Desktop action menu density

At784px, the production static example measures dense/compact/default at28×28,32×32,36×36. The public density recipe owns sizing.

### 22. Final notice position and dark theme

The production static dark example confirms top112px, width416px, dark background rgb(33,33,33), foreground rgb(255,255,255), and no document overflow. This closes the final-position limitation, without claiming contrast acceptance for every page.

### 23. Mobile action menu density

An actual360px iframe measures all three densities at44×44 without horizontal overflow. Resizing the same iframe to768px measures28×28,32×32,36×36. This checks shared component sizing, not every feature menu entry.

### 24. Automation task selection

The real AutomationDetailWorkspace example shows an available task and an offline task with aria-disabled=true. Choosing the available task records device online, task ready, workspace /example/project, closes and restores trigger focus without document overflow. Removing obsolete native-input overrides gives the shared workday checkbox a24×24 desktop target and an explicit accessible name. Scheduler persistence and native device operations remain unverified.

## Component catalog initial-render checks

In the production build, one representative Story per54 groups was opened, preferring Default, and inspected after the Storybook main view and root mounted. All54 had no visible Storybook errors or document overflow at784×526 in light theme. This checks initial rendering, not all206 states, interactions, product pages or native entries.

| Group                              | Initial Story                                         | Visible error | Horizontal overflow |
| ---------------------------------- | ----------------------------------------------------- | ------------- | ------------------- |
| Controls/DeleteIconButton          | `controls-deleteiconbutton--state-matrix`             | 0             | 0                   |
| Controls/Button                    | `controls-button--default`                            | 0             | 0                   |
| Controls/Checkbox                  | `controls-checkbox--default`                          | 0             | 0                   |
| Controls/Feedback                  | `controls-feedback--hint`                             | 0             | 0                   |
| Controls/Field                     | `controls-field--default`                             | 0             | 0                   |
| Controls/IconButton                | `controls-iconbutton--default`                        | 0             | 0                   |
| Controls/MenuChoices               | `controls-menuchoices--default`                       | 0             | 0                   |
| Controls/Menus                     | `controls-menus--selection`                           | 0             | 0                   |
| Controls/OverlayParts              | `controls-overlayparts--arrow-and-shortcut`           | 0             | 0                   |
| Controls/Popover                   | `controls-popover--default`                           | 0             | 0                   |
| Controls/Progress                  | `controls-progress--in-progress`                      | 0             | 0                   |
| Controls/RadioGroup                | `controls-radiogroup--default`                        | 0             | 0                   |
| Controls/RangeSlider               | `controls-rangeslider--default`                       | 0             | 0                   |
| Controls/Resizable                 | `controls-resizable--horizontal`                      | 0             | 0                   |
| Controls/ScrollArea                | `controls-scrollarea--vertical`                       | 0             | 0                   |
| Controls/SearchableSelect          | `controls-searchableselect--default`                  | 0             | 0                   |
| Controls/SegmentedControl          | `controls-segmentedcontrol--default`                  | 0             | 0                   |
| Controls/SelectField               | `controls-selectfield--default`                       | 0             | 0                   |
| Controls/Sortable                  | `controls-sortable--editable-items`                   | 0             | 0                   |
| Controls/Switch                    | `controls-switch--default`                            | 0             | 0                   |
| Controls/Tabs                      | `controls-tabs--default`                              | 0             | 0                   |
| Controls/TextField                 | `controls-textfield--default`                         | 0             | 0                   |
| Controls/Textarea                  | `controls-textarea--default`                          | 0             | 0                   |
| Controls/Toast                     | `controls-toast--success`                             | 0             | 0                   |
| Controls/VirtualTree               | `controls-virtualtree--default`                       | 0             | 0                   |
| Patterns/ComposerComparison        | `patterns-composercomparison--three-production-flows` | 0             | 0                   |
| Patterns/Dialogs                   | `patterns-dialogs--confirmation`                      | 0             | 0                   |
| Patterns/InlinePanel               | `patterns-inlinepanel--template-inline-step`          | 0             | 0                   |
| Patterns/Settings                  | `patterns-settings--group`                            | 0             | 0                   |
| Patterns/ViewportReview            | `patterns-viewportreview--production-surfaces`        | 0             | 0                   |
| Business/AutomationTaskSelection   | `business-automationtaskselection--pinned-tasks`      | 0             | 0                   |
| Business/BoardViewTagPicker        | `business-boardviewtagpicker--default`                | 0             | 0                   |
| Business/BranchPicker              | `business-branchpicker--default`                      | 0             | 0                   |
| Primitives/Collapsible             | `primitives-collapsible--details`                     | 0             | 0                   |
| Business/ComposerProjectSelector   | `business-composerprojectselector--default`           | 0             | 0                   |
| Business/ConversationQueue         | `business-conversationqueue--mixed-ownership`         | 0             | 0                   |
| Business/DeviceSelect              | `business-deviceselect--default`                      | 0             | 0                   |
| Business/GitAccountConfiguration   | `business-gitaccountconfiguration--default`           | 0             | 0                   |
| Business/GroupParticipantsEditor   | `business-groupparticipantseditor--default`           | 0             | 0                   |
| Business/IssueOwnerPicker          | `business-issueownerpicker--default`                  | 0             | 0                   |
| Business/IssueParticipantPicker    | `business-issueparticipantpicker--default`            | 0             | 0                   |
| Business/ContentLayout             | `business-contentlayout--navigation-and-long-notice`  | 0             | 0                   |
| Business/MemberSearchPicker        | `business-membersearchpicker--default`                | 0             | 0                   |
| Business/ModelSelector             | `business-modelselector--default`                     | 0             | 0                   |
| Business/PermissionModeSelector    | `business-permissionmodeselector--default`            | 0             | 0                   |
| Business/PlanningDragAndDrop       | `business-planningdraganddrop--board`                 | 0             | 0                   |
| Business/ProjectAgentPicker        | `business-projectagentpicker--default`                | 0             | 0                   |
| Business/ProjectBoardGroupPicker   | `business-projectboardgrouppicker--default`           | 0             | 0                   |
| Business/ProjectCollaboratorPicker | `business-projectcollaboratorpicker--default`         | 0             | 0                   |
| Business/ProjectSpacePickerMenu    | `business-projectspacepickermenu--default`            | 0             | 0                   |
| Pages/RuntimeSettings              | `pages-runtimesettings--ready`                        | 0             | 0                   |
| Business/TaskDescriptionEditor     | `business-taskdescriptioneditor--editable`            | 0             | 0                   |
| Design/Project Assistant Status    | `design-project-assistant-status--project`            | 0             | 0                   |
| Navigation/ProjectViewSwitcher     | `navigation-projectviewswitcher--grouped-work`        | 0             | 0                   |

The mechanical detector reported one border-accent-on-rounded warning. The actual source is the selected TabsTab underline in WeworkIssueHomeComposer.tsx (border-b-2), not a decorative card border; it is classified as a false positive and preserved. The detector did not inspect native rendering.

## Packaged Electron verification (93154da584)

- The cloud connection transcript settings passed `transcript-sync`, covering the disabled default, explicit activation and cloud synchronization. [Core 5 log](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269750)
- The plugin creation action and workspace debug sidebar passed `plugin-development`. [Core 8 log](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269414)
- The collaboration split panes passed `collaboration-exp`, covering keyboard resizing, real pointer dragging and restoring the layout with Escape. [Core 4 log](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269385)
- Board ordering and cross-column changes survived reload. The notification-to-board scenario started dragging while the detail drawer was still closing. The scenario now waits for the drawer to close and awaits verification. [Core 10 log](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269383) [Core 5 log](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269750)

## Remaining native acceptance boundaries

- All 234 source owners and 45 real Pages have not been opened individually. Unresolved entries, delegated forms, popout workbench, process views and device/plugin/application workspaces require authentication and native-host prerequisites.
- Local Story ports do not establish cloud persistence, real executors, Git/filesystem, update/rollback, operating-system permissions or connection compatibility. Roles, ownership, read-only, disconnected and failure states require real authorized scenarios.
- Native IME composition, clipboard/selection, complete Tab/Shift+Tab flows, pointer dragging and touch lack complete evidence. Themes, contrast and all native window sizes have not received page-by-page acceptance.
- Final Toast positioning has been rechecked; production split/portal lifetimes retain their recorded limits. The multi-iframe dynamic-import failure was not proven to be a production component defect; reducing iframe count is not presented as a root-cause fix.
- Source inspection found the template dialog CSS `[open]` contract incompatible with SDK `data-open`; it was changed to `[data-open]`. A legacy device-actions `[open]` rule had no live TSX references in the snapshot and is classified as dead CSS, not an invented visual failure. Business `data-state` values are not SDK state contracts.

Public export example coverage is 112 entries: 100 direct examples, 5 production compositions and 7 nonvisual APIs, including the latest real SortableDragArea composition. These are catalog-coverage counts only; see the [component library](./component-library.md). They do not change page acceptance status.
