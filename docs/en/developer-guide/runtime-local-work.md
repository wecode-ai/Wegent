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

The executor still keeps a JSON LocalTask index for non-Codex or imported local tasks:

```text
$WEGENT_EXECUTOR_HOME/runtime-work/index.json
```

Native Codex tasks are not written to this index. List refresh discovers them from the Codex SDK and Codex session files, and running state is derived from Codex status plus the session transcript. Runtime handles do not depend on SQLite and are not synced to the central database.

## List Refresh

The frontend drives task list refreshes through polling.

1. Wework periodically requests `GET /api/runtime-work?client_origin=wework`.
2. Backend reads the user's Projects and Device Workspace mappings.
3. Backend calls `runtime.tasks.list` over the online device WebSocket RPC channel.
4. The executor refreshes local Codex discovery and merges the non-Codex/imported JSON LocalTask index.
5. Backend groups results by `deviceId + workspacePath` and returns Project -> Device Workspace -> LocalTask, while each LocalTask is still opened and notified by `deviceId + localTaskId`.

The executor does not poll or push task lists to Backend by itself. Offline devices do not contribute LocalTasks. Wework may show an offline mapped workspace, but it does not keep a central cache of local tasks.

## Open And Continue

When a user opens a LocalTask, Wework calls Backend:

```text
POST /api/runtime-work/transcript
```

Backend forwards `deviceId + localTaskId` to the owning device with `runtime.tasks.transcript`. Native Codex tasks are located through their Codex session path or session-file discovery. Non-Codex/imported tasks may use `workspacePath` as a local-index lookup hint, or locate the task from the local LocalTask index by `localTaskId`. The executor reads the native runtime transcript and returns normalized messages.

When a user continues a LocalTask, Wework calls:

```text
POST /api/runtime-work/send
```

Backend forwards `runtime.tasks.send`. The executor resumes the runtime session from the local LocalTask's opaque runtime handle. Claude Code tasks write the local transcript back to the JSON LocalTask index. Native Codex tasks only continue the Codex SDK thread; messages and status come from Codex's own session records and are not written back to the executor JSON index. Streaming Responses events carry `local_task_id` and runtime metadata, not `workspacePath`.

Native Codex tasks have one additional rule: transcript refreshes trust only Codex's own session transcript. `runtimeHandle.messages` from a fork package or the executor JSON index is only an import-time snapshot and must not be used as a fallback for native Codex transcripts; otherwise Wework can show stale messages or lose follow-up turns after refresh. Non-SDK native tasks may still use the executor JSON index as their local transcript source.

## Workspace Tool Context

After Wework opens a LocalTask, the right-side file, review, and terminal tools resolve their device and directory from the current LocalTask's device and directory context:

- The LocalTask `workspacePath` returned by `runtime.tasks.list` wins, so a Codex worktree is not treated as a separate Project.
- If the LocalTask maps to a Project, environment info and review still receive that Project, but Git commands run in the LocalTask's actual directory.
- If the LocalTask does not map to a Project, the local terminal can still open as long as the device is online and the directory is accessible. IDE capabilities that depend on Project APIs still require Project context.
- Terminals opened for runtime LocalTasks must start a device-scoped PTY from the current LocalTask's `deviceId + workspacePath` and must not fall back to the Project's default bound device; otherwise cross-device worktrees open on the wrong machine.

## Create Tasks

Wework creates a new runtime task with:

```text
POST /api/runtime-work/create
```

Backend resolves the target device and directory from either a Project mapping or a standalone device workspace, builds a transient execution request, and calls device RPC `runtime.tasks.create`. This flow does not `db.add()` any `TaskResource` or `Subtask`.

The runtime owns persistence for newly created tasks:

- Claude Code creates an executor JSON LocalTask and stores the transcript and runtime handle in that index.
- Codex creation first returns an executor-process-local `localTaskId` so the frontend can open the task and receive stream events immediately. After the native Codex SDK thread starts in the background, the real Codex threadId is stored in the in-memory runtime handle for later send/resume calls.
- Codex creation and continuation do not cache the task in the executor JSON index. The current executor process keeps a temporary in-memory record to cover the short window before Codex discovery can see the new thread; after an executor restart, native Codex discovery/session data is authoritative again.
- Codex creation still streams over the LocalTask Responses event channel with `response.created`, text/tool deltas, and `response.completed`/`error`. Those events use the `localTaskId` returned by create, so the frontend does not need to wait for the next list refresh to show the running reply.
- Attachments still go through the executor Codex attachment pipeline: Backend sends attachment ids only, and the executor downloads and converts them on the target device for the Codex SDK. The frontend does not send local attachment paths.

Project-backed creation must use a trusted Device Workspace mapping:

- Wework sends `projectId + deviceWorkspaceId`; it does not send `workspacePath`.
- Backend verifies that `deviceWorkspaceId` belongs to the current user and the requested `projectId`, then resolves the trusted `deviceId + workspacePath` from that mapping.
- If a Project has exactly one available Device Workspace, the frontend may select it directly. If it has multiple available Device Workspaces, the frontend must ask the user to confirm the runtime location before sending.
- Legacy Project configuration that stores `execution.deviceId + workspace.localPath` is materialized into a Device Workspace mapping during runtime work list refresh, so older Projects use the same trusted mapping path.

Standalone non-Project device workspaces still use `deviceId + workspacePath` for task creation. That path only applies to explicitly selected unmapped device workspaces and must not be used as a frontend-supplied Project task target.

## Fork And Cross-Device Transfer

When Wework forks a runtime task, it only offers target workspaces that belong to the source task's Project:

- Other Device Workspaces already bound to that Project can be used directly.
- An online device that is not yet bound to that Project must first use the same device-directory preparation flow as project creation and editing: choose a directory on the device, then choose whether that Project path is a `worktree` or a regular `workspace`.
- Backend writes the Device Workspace mapping through `POST /api/runtime-work/device-workspaces/prepare` before continuing the fork.
- A Device Workspace `label` can store `worktree` or `workspace`. Runtime work list responses prefer that label as `workspaceKind`, so the frontend does not treat a worktree under the same Project as another Project and does not show unrelated Project or unmapped directories as fork targets.
- If the Project has `git` configuration, Backend first verifies that the source and target workspaces have the same Git remote and that the source task `HEAD` commit is reachable in the target repository. After that, the target device does not import the task into the Project root. It creates or reuses a detached Git worktree under `worktrees/<transferId>/<projectDir>` for the target Project workspace, then binds the forked LocalTask to that worktree path. This prevents the fork from mutating the target Project root, while list refresh can still group the worktree task under the same Project.
- Git forks copy task context, Codex session state, required session files, and a lightweight Git patch generated from the public base commit. The patch covers source-workspace local commits, uncommitted tracked-file changes, and non-ignored untracked files as an overlay; it does not archive and upload the full Git repository directory to object storage. If Git requirements are not met, Backend uses the regular archive transfer path.
- If the Project is not Git-backed, the fork uses executor direct archive transfer and only falls back to object storage when direct transfer is unavailable.
- Direct archive transfer only tries the TCP peer host observed from the Backend WebSocket connection and the runtime transfer host reported by the executor. The executor validates the peer with a token probe before upload, so a NAT/proxy-reported business address is not trusted by itself. If direct transfer is unavailable and object storage is not configured, Backend returns 503 instead of silently falling into an unusable S3 path.

The forked task identity still uses `deviceId + localTaskId`. `workspacePath` is only target-directory and workspace-tool context.

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
