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
- Backend and Wework only hold a transient `RuntimeTaskAddress`: `deviceId`, `workspacePath`, and `localTaskId`.

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
5. Backend groups results by `deviceId + workspacePath` and returns Project -> Device Workspace -> LocalTask.

The executor does not poll or push task lists to Backend by itself. Offline devices do not contribute LocalTasks. Wework may show an offline mapped workspace, but it does not keep a central cache of local tasks.

## Open And Continue

When a user opens a LocalTask, Wework calls Backend:

```text
POST /api/runtime-work/transcript
```

Backend forwards the `RuntimeTaskAddress` to the owning device with `runtime.tasks.transcript`. The executor reads the native runtime transcript and returns normalized messages.

When a user continues a LocalTask, Wework calls:

```text
POST /api/runtime-work/send
```

Backend forwards `runtime.tasks.send`. The executor resumes Codex or Claude Code from the local LocalTask's opaque runtime handle and writes the result back to the local JSON index.

## Create Tasks

Wework creates a new runtime task with:

```text
POST /api/runtime-work/create
```

Backend resolves the target device and directory from either `projectId` or `deviceId + workspacePath`, builds a transient execution request, and calls device RPC `runtime.tasks.create`. This flow does not `db.add()` any `TaskResource` or `Subtask`.

## Non-Project Workspaces

Directories discovered by an executor but not mapped to a central Project appear in Wework under "Unmapped Device Workspaces". They also come from online device `runtime.tasks.list` responses, not from central database tasks.

## Compatibility

Wegent-native Task/Subtask flows remain available for existing chat, shared task, and historical task URL paths. Wework sidebar, mobile drawer, project task display, and new task creation use the runtime work API instead of the DB task list.
