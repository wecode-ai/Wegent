---
sidebar_position: 41
---

# Workspace tab navigation

Inbox entries, system notifications, tray actions, and cross-product links select a
tab of the destination kind. `navigateTo` dispatches the shared navigation event
for built-in task, project-space, Agent, registered DSH routes, and app destinations.
For cross-surface navigation, `navigateWorkspaceTab` selects the destination without converting the current
project-space tab into a task tab. `resolveWorkspaceTabKind` is shared by
navigation and tab-kind inference.

Inbox and tray entries use the shared task scheme. Tasks first match an existing conversation by device ID and task ID. Otherwise,
navigation reuses the active tab of that kind, a fixed tab, or another tab of the
same kind, creating one only when none exists. Repeated clicks do not add tabs.
Ordinary navigation within the same surface keeps the existing location update
without synchronously reselecting the tab. Tasks and auxiliary pages share the
workbench surface, so opening an app or returning to a new conversation preserves
the tab and pending conversation state updates.
Settings temporarily replace the surface and retain the return location.
Routes containing `workspaceTab` explicitly address a tab and bypass navigation
events. Non-workspace routes such as login retain page navigation.

## Regression verification

The `notification-tab-navigation` desktop checkpoint runs in GitHub Core shards.
It uses a real local task, executor, and Electron tray; only model responses use
the scenario's test service:

1. Switch to a project space while a task runs, then open it through the tray and
   reuse its original tab.
2. Return to the project space, complete the task, and open its inbox entry;
   verify the completion and cleared unread state.
3. Return to the project space and open the same task through a system
   notification without adding tabs.
4. Revisit the original project-space tab and verify its route after each action.

Run `pnpm --filter wework e2e:desktop --segment notification-tab-navigation`.
The checkpoint creates its own project and task; the shared runner cleans up
isolated directories and processes. Unit tests also cover built-in routes,
existing conversations, repeated navigation, settings, and explicitly addressed tabs.

App destinations include declared native paths, `/app/<id>`, and nested paths,
so app-switching links also preserve the current tab.

Local verification on 2026-10-24 passed focused Vitest
tests, TypeScript, ESLint, formatting, CI classification tests, and the checkpoint
in isolated macOS Electron. An additional `ai:verify` check opened a notification
for an unavailable device and returned to the original project-space tab.
Temporary evidence stays in local `wework/test-results/`; runtime directories and
session files are not committed.
The existing new-conversation and in-tab app-navigation E2E assertions remain
intact; after the correction, local `workspace-tabs` and `priority-filter`
checkpoints passed.
