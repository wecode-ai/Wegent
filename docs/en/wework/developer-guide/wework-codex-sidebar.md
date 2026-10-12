---
sidebar_position: 24
---

# Codex sidebar state parity

The Wework desktop app follows the Codex App sidebar state model. Project and live task content comes from the Codex app-server, while sidebar metadata comes from `.codex-global-state.json` in the target device's `CODEX_HOME`. While a remote device is online, Wework also stores a local task-list summary for startup recovery after that device goes offline.

## State ownership

| Data                                       | Source of truth                                | Notes                                                                              |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Project names, roots, and kinds            | Codex global state                             | Covers legacy roots, multi-root `local-projects`, and `remote-projects`            |
| Project order, pins, and appearance        | Codex global state                             | Uses `project-order`, `pinned-project-ids`, and `project-appearances`              |
| Task title, timestamps, and runtime status | Codex app-server + Wework remote summary cache | Task bodies are not cached; cached runtime status is always stopped                |
| Task grouping, order, and pins             | Codex global state                             | Uses assignments, workspace hints, per-project thread order, and pinned thread IDs |
| Expansion and scroll preferences           | Wework localStorage                            | UI-only preferences that do not affect Codex                                       |

A device project's UI identity combines the execution device with its real project key. The local remote descriptor retains that UI identity and records its local sidebar state key separately, so initial synchronization and primary-folder changes preserve project selection. Identical paths or project keys on different devices remain isolated.

A task UI identity combines the state-owning device with the task ID. Live-list refreshes merge tasks only by that identity; title, workspace path, and runtime kind are not identity fields. Distinct tasks can share a title, such as consecutive attachment-only submissions with no text, so neither the frontend nor Executor may infer duplicates from those display fields.

New project tasks that have not entered the manual order appear before existing manually ordered tasks; multiple unordered tasks are sorted by their latest activity. Tasks with a manual order continue to follow `sidebarOrder`. This keeps an optimistic task without `sidebarOrder` at the top immediately, then preserves its position after Executor returns the persisted order instead of dropping it to the bottom.

The project list must not depend on the array order of any individual local, cloud, or cached response. Executor derives `projectSidebarOrder` from `project-order`; Wework preserves it in project summaries and the offline cache, then reapplies it after merging runtime work sources. Projects without persisted order keep their relative merge order, while ordered projects do not move because of task activity, request completion timing, or device reconnection.

## Project model

Executor merges three Codex project representations:

1. `electron-saved-workspace-roots` and `electron-workspace-root-labels` for legacy single-root projects.
2. `local-projects` and `project-writable-roots` for current local multi-root projects.
3. `remote-projects` for projects on remote hosts.

Thread grouping applies this precedence: exclusion through `projectless-thread-ids`, explicit `thread-project-assignments`, `thread-workspace-root-hints`, then longest-root path matching. Explicit metadata always wins over path inference.

## Project editing across devices

Local, cloud, and remote project menus and in-conversation project actions use the same editor. Users can change the project name, add or remove source folders, choose the primary folder, and configure project instructions, the default model, quick phrases, and plugins. The default project space remains controlled by the experimental feature flag.

All source folders belong to the project's execution device, and at least one folder must remain. The first folder is the primary directory for new conversations. Local projects use the native folder picker; cloud and remote projects browse the target device through the device folder picker. Desktop paths cannot be saved as remote folders. Executor verifies that each folder exists and is a directory before saving.

Execution ownership is stored separately from local sidebar ownership. Edit requests target the execution device and its real project key, saving the complete configuration in that device's `CODEX_HOME`. The local remote-project descriptor retains the full folder and settings projection for refreshes and offline viewing. Stable identities keep primary-folder changes from creating duplicate projects or resetting order, pins, or appearance. Plugin reads and installations also target the execution device, with caches isolated by device.

Updated folders and AI settings apply to new conversations. Existing conversations retain their saved working directory, writable folders, and project execution settings; users can still explicitly change the current turn's model or other conversation controls. Removing a source folder does not delete its files.

An offline device's editor can display saved settings, but saving and plugin installation are disabled. A failed save retains the draft. If the execution device saves successfully but local index synchronization fails, the UI reports the synchronization error.

## Writes and concurrency

Wework sends semantic mutations such as “move project A before B” or “pin thread T”; the frontend never overwrites the complete JSON document. Executor reads the latest state and computes the affected arrays for each mutation.

When Codex App is not running, Executor writes a same-directory temporary file, flushes it, and atomically replaces global state. While Codex App is running, mutations are appended to a JSONL oplog. Reads overlay pending mutations on disk state for immediate UI feedback. After Codex exits, Executor merges the oplog into the latest disk state. Unknown fields are preserved by every write.

Local projects are mutated by the local Executor in the local `CODEX_HOME`. While a device is online, remote projects are mutated by the Executor on the owning device. Backend does not persist sidebar state.

When Wework synchronizes remote-project descriptors into the local Executor, each non-empty batch is authoritative for the remote hosts represented in that batch. Executor updates the listed projects and removes stale projects for those hosts, including their order, pin, appearance, and task-assignment metadata. Hosts absent from the batch remain unchanged, and an empty batch does not clear remote projects, preventing a temporarily incomplete local view from deleting offline-device state.

## Offline remote task recovery

After a cloud or remote task-list sync succeeds, Wework stores a per-user, allowlisted summary in local `localStorage`. It includes task IDs, titles, update times, workspace paths, repository and branch hints, and sidebar ordering metadata. Project projections also retain execution ownership, all source folders, the default project space, and AI settings for offline viewing. Default models retain only their name, type, and conversation options. The cache excludes device or model credentials, complete model endpoint configuration, conversation bodies, tool calls, runtime handles, and parent or child task trees. Full conversation details remain only on the remote device.

At startup, the cached summary is merged as stale data with the local Codex remote-project descriptors. When the remote device is unavailable, the project, last known IP, and task summaries remain visible with a gray status dot. Task rows cannot be opened, pinned, renamed, subscribed, or archived. After the device reconnects, the live list becomes authoritative and updates or removes cached entries. A failed device discovery or task-list sync keeps the previous summary so a temporary network error does not empty the sidebar.

An unavailable remote device and an explicitly disconnected cloud session are different states. As long as Wework remains connected to the cloud, projects for offline devices stay visible under the rules above. When the user explicitly disconnects the cloud session, Wework temporarily hides remote projects, remote tasks, and remote chats without deleting the local summary cache or `remote-projects` in Codex global state. Reconnecting first restores the saved remote projects from the cache, then refreshes them from the live device and task lists. Local projects are unaffected.

Removing a cloud or remote project while its device is offline is local to the current Wework instance. Wework deletes the corresponding `remote-projects` descriptor from the local Codex global state and clears its local summary cache without contacting the offline device or deleting project state or workspace files there. The project therefore stays absent across refreshes and Wework restarts while the device remains offline. It may reappear after the device reconnects and reports the same workspace again.

## Interaction boundary

- When the Cloud Work entry reports `Available`, clicking the row opens the dedicated Cloud work page. Its trailing settings action still opens Connections settings.
- Clicking a project only expands or collapses its tasks and does not change the center pane.
- Clicking a task or creating a project task changes the main content.
- Projects, pinned projects, pinned tasks, and tasks within one project support semantic drag ordering.
- Tasks can only be reordered within their current project. There is no cross-project drop target, and dragging never changes `thread-project-assignments`.
- Ellipsis menus and context menus share the same project or task action set.
