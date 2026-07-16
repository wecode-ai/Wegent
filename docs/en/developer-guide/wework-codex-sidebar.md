---
sidebar_position: 24
---

# Codex sidebar state parity

The Wework desktop app follows the Codex App sidebar state model. Project and task content still comes from the Codex app-server, while sidebar metadata comes from `.codex-global-state.json` in the target device's `CODEX_HOME`.

## State ownership

| Data | Source of truth | Notes |
| --- | --- | --- |
| Project names, roots, and kinds | Codex global state | Covers legacy roots, multi-root `local-projects`, and `remote-projects` |
| Project order, pins, and appearance | Codex global state | Uses `project-order`, `pinned-project-ids`, and `project-appearances` |
| Task title, timestamps, and runtime status | Codex app-server | Task content is not copied into global state |
| Task grouping, order, and pins | Codex global state | Uses assignments, workspace hints, per-project thread order, and pinned thread IDs |
| Expansion and scroll preferences | Wework localStorage | UI-only preferences that do not affect Codex |

A project UI identity combines the state-owning device with the project key. Identical paths on different devices therefore remain isolated.

## Project model

Executor merges three Codex project representations:

1. `electron-saved-workspace-roots` and `electron-workspace-root-labels` for legacy single-root projects.
2. `local-projects` and `project-writable-roots` for current local multi-root projects.
3. `remote-projects` for projects on remote hosts.

Thread grouping applies this precedence: exclusion through `projectless-thread-ids`, explicit `thread-project-assignments`, `thread-workspace-root-hints`, then longest-root path matching. Explicit metadata always wins over path inference.

## Writes and concurrency

Wework sends semantic mutations such as “move project A before B” or “pin thread T”; the frontend never overwrites the complete JSON document. Executor reads the latest state and computes the affected arrays for each mutation.

When Codex App is not running, Executor writes a same-directory temporary file, flushes it, and atomically replaces global state. While Codex App is running, mutations are appended to a JSONL oplog. Reads overlay pending mutations on disk state for immediate UI feedback. After Codex exits, Executor merges the oplog into the latest disk state. Unknown fields are preserved by every write.

Local projects are mutated by the local Executor in the local `CODEX_HOME`. Remote projects are mutated by the Executor on the owning device. Backend does not persist sidebar state.

## Interaction boundary

- Clicking a project only expands or collapses its tasks and does not change the center pane.
- Clicking a task or creating a project task changes the main content.
- Projects, pinned projects, pinned tasks, and tasks within one project support semantic drag ordering.
- Tasks can only be reordered within their current project. There is no cross-project drop target, and dragging never changes `thread-project-assignments`.
- Ellipsis menus and context menus share the same project or task action set.
