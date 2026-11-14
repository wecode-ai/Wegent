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
When another tab already contains the destination task, navigation first selects
that tab by device and task identity, preserving the current conversation tab.
Settings temporarily replace the surface and retain the return location.
Routes containing `workspaceTab` explicitly address a tab and bypass navigation
events. Non-workspace routes such as login retain page navigation.

## Collaboration experiment tab

`collab.experience.v1` maps to the default-off device preference `collaborationExperienceEnabled`. General settings exposes Collaboration experience preview after Experimental features is enabled and keeps its rollback switch available while the preview is on. Its fixed-tab preference uses auxiliary kind, ID `fixed-collaboration-exp` and route `/collaboration-exp`, without extending tab kinds.

Disabling the flag filters the visible tab projection and unmounts the route while retaining raw fixed and session tab records. Re-enabling restores those records and queries. The experiment has its own lazy loading and retryable error boundary; `/todo` remains independent.

The explicit `wework://collaboration-exp?...` scheme and internal route retain query fields. Existing `wework://boards/...` notifications select an experiment only when its flag is enabled and a tab already exists. They update source, project and task, retain list filters, and clear stale node/discussion selection. Other cases retain the original `/todo` path. Direct `/todo` UI navigation does not use this selection rule.

The `collaboration-exp` desktop checkpoint runs in an existing Core CI shard, creates its own real local and cloud data and reuses one real native conversation. It observes disabled target requests and covers original object and conversation references, source-turn isolation, ordinary assistant questions without an Issue, permission changes blocking publication, duplicate submissions publishing once, and query/draft restoration after both reload and a real Electron restart. Only model responses are synthetic. Unit tests cover the disabled flag, hidden-state restoration, deep-link queries, notification targets, assistant navigation and local retry. E2E and `ai:verify` were not run locally for this change.

## Reading conversation state

The conversation cache owns messages, goals, plans, subagent status, and the send queue.
Composers read these values through external-store subscriptions instead of copying them
into another set of component states. Empty queue snapshots retain their identity, so
ordinary progress blocks do not change queue state. Message rendering keeps its frame
subscription; edit, retry, and question-response actions read the latest cached messages
rather than a view snapshot that has not refreshed yet.

## Restoring fixed tab titles

The default collaboration tab displays “Collaboration” without a Beta suffix.
Session tabs and fixed-tab preferences share `normalizePersistedTab` to update
legacy titles, both on initial load and when preferences load asynchronously.
Only built-in legacy titles pointing to the collaboration home are updated;
custom titles for specific projects remain unchanged.
`WorkspaceTabsContext.test.tsx` covers legacy Chinese and English titles,
startup restoration, and asynchronous fixed-tab loading.

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
