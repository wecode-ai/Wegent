---
sidebar_position: 16
---

# Runtime Local Work

Wework runtime local work surfaces Codex and Claude Code work that already exists on a user's device. It does not import that work into central `TaskResource` or `Subtask` rows. The visible model has three levels:

```text
Project
  Device Workspace
    LocalTask
```

## Ownership

- Project is central Backend state.
- Device Workspace is a central mapping from user, device, and local directory to a Project.
- LocalTask is executor-local state and remains on the device.
- A LocalTask's stable identity is `deviceId + localTaskId`. `workspacePath` is only device-workspace context for list grouping, task creation, and right-side workspace tools; task URLs, IM notification subscriptions, and native Codex update deduplication do not use the path as an identity field.

The executor stores the LocalTask index as JSON:

```text
$WEGENT_EXECUTOR_HOME/runtime-work/index.json
```

It does not depend on SQLite, and it does not sync Codex or Claude Code runtime handles into the central database.

## List Refresh

The frontend drives task list refreshes through polling.

1. Wework periodically requests `GET /api/runtime-work?client_origin=wework`.
2. Backend reads the user's Projects and Device Workspace mappings.
3. Backend calls `runtime.tasks.list` over the online device WebSocket RPC channel.
4. The executor refreshes local Codex discovery and the JSON LocalTask index.
5. Backend groups results by `deviceId + workspacePath` and returns Project -> Device Workspace -> LocalTask, while each LocalTask is still opened and notified by `deviceId + localTaskId`.

The executor does not poll or push task lists to Backend by itself. Offline devices do not contribute LocalTasks. Wework may show an offline mapped workspace, but it does not keep a central cache of local tasks.

## Open And Continue

When a user opens a LocalTask, Wework calls Backend:

```text
POST /api/runtime-work/transcript
```

Backend forwards `deviceId + localTaskId` to the owning device with `runtime.tasks.transcript`. If the request includes `workspacePath`, the executor uses it as a local-index lookup hint; otherwise, it locates the task from the local LocalTask index by `localTaskId`. The executor reads the native runtime transcript and returns normalized messages.

When a user continues a LocalTask, Wework calls:

```text
POST /api/runtime-work/send
```

Backend forwards `runtime.tasks.send`. The executor resumes Codex or Claude Code from the local LocalTask's opaque runtime handle and writes the result back to the local JSON index. Streaming Responses events carry `local_task_id` and runtime metadata, not `workspacePath`.

## Workspace Tool Context

After Wework opens a LocalTask, the right-side file, review, and terminal tools resolve their device and directory from the current LocalTask's device and directory context:

- The LocalTask `workspacePath` returned by `runtime.tasks.list` wins, so a Codex worktree is not treated as a separate Project.
- If the LocalTask maps to a Project, environment info and review still receive that Project, but Git commands run in the LocalTask's actual directory.
- If the LocalTask does not map to a Project, the local terminal can still open as long as the device is online and the directory is accessible. IDE capabilities that depend on Project APIs still require Project context.

## Create Tasks

Wework creates a new runtime task with:

```text
POST /api/runtime-work/create
```

Backend resolves the target device and directory from either `projectId` or `deviceId + workspacePath`, builds a transient execution request, and calls device RPC `runtime.tasks.create`. This flow does not `db.add()` any `TaskResource` or `Subtask`.

## Non-Project Workspaces

Directories discovered by an executor but not mapped to a central Project appear in Wework under "Unmapped Device Workspaces". They also come from online device `runtime.tasks.list` responses, not from central database tasks.

## IM Notifications

Runtime tasks can send notifications to IM sessions, but notification state is keyed by `deviceId + localTaskId`; no DB Task is created, and `workspacePath` is not part of the notification key.

- In IM, `/notify on` enables the current user's global runtime task notification target for the current IM session.
- `/notify off` disables global notifications, and `/notify status` reports the current state.
- A single IM session can subscribe to one runtime task and receive only that task's updates.
- When the executor detects a native Codex task timestamp change, it sends `runtime.tasks.updated` without `workspacePath`, but with `status` and `content`, only after the last assistant message reaches a terminal state and contains reply content. Backend ignores running or streaming updates and delivers the terminal reply according to task subscriptions and global notification settings.
- Wegent runtime sends and the native Codex watcher use the same `deviceId + localTaskId` for deduplication, so Codex and Wework do not notify twice for the same task update.

## URL

Wework runtime task URLs use:

```text
/runtime-tasks?deviceId=<device>&localTaskId=<local-task>
```

The URL does not contain `workspacePath`. On refresh or shared links, the frontend opens the task from `deviceId + localTaskId` and then restores its workspace context from the latest runtime work list.

## Compatibility

Wegent-native Task/Subtask flows remain available for existing chat, shared task, and historical task URL paths. Wework sidebar, mobile drawer, project task display, and new task creation use the runtime work API instead of the DB task list.
