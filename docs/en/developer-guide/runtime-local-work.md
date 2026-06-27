---
sidebar_position: 16
---

# Runtime Local Work

Wework runtime local work surfaces Codex and Claude Code work that already exists on a user's device. It does not import that work into central `TaskResource` or `Subtask` rows, and it no longer depends on the Backend `projects` table to build the sidebar list. The list comes from runtime threads returned by online device executors and is shown in two groups:

```text
Project
  LocalTask

Conversation
  LocalTask
```

## Ownership

- Project is a display group inferred from the runtime workspace information returned by the executor.
- Conversation is a Codex chat thread that does not belong to a Project workspace.
- LocalTask is executor-local state and remains on the device.
- A Project's runtime identity is a workspace key derived from `deviceId + workspacePath`, not a central `projects.id`. Wework may create temporary UI ids inside components, but those ids must not be written back to Backend or placed in URLs as project identity.
- A LocalTask's stable identity is `deviceId + localTaskId`. `workspacePath` is only device-workspace context for list grouping, task creation, and right-side workspace tools; task URLs, IM notification subscriptions, and native Codex update deduplication do not use the path as an identity field.
- The executor returns `workspaceKind` to distinguish Project work from Conversations. Codex App-style directories such as `~/Documents/Codex/YYYY-MM-DD/<name>` are marked as `chat` and shown under "Conversations"; other workspaces are shown under "Projects".

Rust executor keeps a device-side JSON LocalTask index for runtime work:

```text
$WEGENT_EXECUTOR_HOME/runtime-work/index.json
```

Codex tasks are discovered and controlled through the `codex app-server --stdio` JSON-RPC protocol. The executor stores the Wegent `localTaskId`, workspace, title, status, and real Codex `threadId` mapping in this index so app-mode task creation can recover after a restart. The full transcript remains authoritative in the Codex app-server `thread/read` response and is not synced to the central database.

## List Refresh

Wework requests the task list on startup, explicit refresh, or device-state changes. It no longer refreshes the list through a fixed polling interval.

1. Wework requests `GET /api/runtime-work`.
2. Backend reads the current user's online devices and calls `runtime.tasks.list` over each device WebSocket RPC channel.
3. The executor refreshes local Codex threads through app-server `thread/list` and merges the device-side JSON LocalTask index.
4. The executor returns `workspaceKind`, workspace path, task title, update time, and device status.
5. Backend performs light aggregation and returns the result to Wework without reading or matching the Backend `projects` table.
6. Wework renders Projects and Conversations from the runtime work response, while each LocalTask is still opened and notified by `deviceId + localTaskId`.

The `runtime.tasks.list` response has two workspace levels. The outer workspace is the sidebar Project grouping, so Codex git worktree tasks should be grouped under their shared repository root. The inner LocalTask is the actual execution directory and must keep its own `workspacePath`. When that directory is a git worktree, the LocalTask must carry `workspaceKind: worktree` and `worktreeId`; the sidebar worktree icon, bottom terminal cwd, and right-side workspace tools all derive from LocalTask fields. A worktree LocalTask must not turn the parent workspace into a worktree, and the LocalTask path must not be overwritten with the parent workspace path.

The executor does not poll or push task lists to Backend by itself. Offline devices do not contribute LocalTasks. Wework may show an offline mapped workspace, but it does not keep a central cache of local tasks.

When there is only one device, Wework does not show an IP next to Project names. When there are multiple devices, the local device still omits the IP, while online remote devices show a usable non-loopback runtime transfer host or client IP with a green online dot. Remote project and remote host pickers also use that IP/host as the primary display label; the device id is only a technical fallback when no network address is available.

## Search

Wework searches device-local work with:

```text
POST /api/runtime-work/search
```

Backend fans out `runtime.tasks.search` only to the current user's online or busy devices. It does not read central `TaskResource`, `Subtask`, or cached history rows. The executor searches local task titles and transcripts, then returns snippets, message metadata, update time, device name, workspace path, and the transient task address.

Search results are merged by `updatedAt` descending and capped by the request `limit`. `includeArchived` is passed to the executor so it can decide whether archived LocalTasks are included. When the request includes `projectId`, Backend derives the Project from each workspace path and only returns results under that Project; `workspaceKind: chat` Conversation results have no Project owner.

The frontend search dialog opens only the `deviceId + localTaskId` address from the result, then restores workspace context from the latest runtime work list.

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

Backend forwards `runtime.tasks.send`. The executor resumes the runtime session from the local LocalTask's opaque runtime handle. Codex tasks use the saved `threadId` to call app-server `thread/resume`, then send the new turn with `turn/start`. Messages and status come from the Codex thread transcript; the executor JSON index stores task-link metadata only. Streaming Responses events carry `local_task_id` and runtime metadata, not `workspacePath`.

If the current LocalTask is still replying, Wework queues new user input locally instead of sending concurrent `runtime.tasks.send` calls. Users can remove queued messages, or choose to stop the current reply and send the queued message from the queue panel. That first calls:

```text
POST /api/runtime-work/cancel
```

Backend forwards `deviceId + localTaskId` as `runtime.tasks.cancel`. The Rust executor Codex app-server path currently does not interrupt an in-flight turn across processes, so app mode returns `accepted: false`; the frontend should keep the queued state or wait for the current turn to finish. If `turn/interrupt` support is added later, it must still identify the task only by `deviceId + localTaskId`; `workspacePath` remains device-directory context.

Continuing a LocalTask may include already uploaded attachment ids that are in the ready state. Backend verifies those attachments belong to the current user and converts them into executor attachment metadata. The executor downloads and converts the files on the target device before passing them to the runtime. The frontend never sends local attachment paths directly to Backend or executor.

## Archived Conversations

Archived conversations are also device-side state. Backend only validates the user, device, and workspace, then dispatches the request to the target executor. It does not read or write `TaskResource.STATE_ARCHIVED`, and it does not call the central `/tasks/archived` flow. Wework builds the archived list only from runtime Projects and Conversations, so the page does not show data outside the current Codex Lite sidebar scope.

The archive HTTP APIs are:

```text
POST /api/runtime-work/archived-conversations/list
POST /api/runtime-work/archived-conversations/archive
POST /api/runtime-work/archived-conversations/archive-project
POST /api/runtime-work/archived-conversations/archive-all
POST /api/runtime-work/archived-conversations/unarchive
POST /api/runtime-work/archived-conversations/delete
POST /api/runtime-work/archived-conversations/delete-bulk
```

For native Codex conversations, the executor archives, unarchives, and deletes through app-server `thread/archive`, `thread/unarchive`, and `thread/delete`; renaming uses `thread/name/set`. Archived lists come from `thread/list` with the archived filter and are merged with the JSON LocalTask index. List responses normalize `id`, `localTaskId`, title, Project name, workspace path, device, source, and timestamp fields, and include grouped Project counts. Bulk delete only applies to the archived item set submitted by the frontend.

After an image attachment uploads successfully, Wework keeps a frontend-local `local_preview_url` on the current page's `Attachment` object. The sent message can display the image immediately without fetching the same attachment through the download API again. This field belongs only to frontend render state; it is not written to Backend and is not sent through `attachment_ids` or executor requests. After a page refresh, persisted attachment ids remain the source of truth.

When rendering a message that already has persisted image attachments, Wework prefers those attachment previews and ignores local image file mentions embedded in the Codex prompt. This avoids showing both the uploaded attachment and a temporary local path. Codex local image mentions are used only as a same-device preview fallback when no attachment record exists. If the current environment cannot convert the local path through Tauri `convertFileSrc`, or the converted image fails to load, the frontend does not display that local path.

When the executor discovers a user message from a native Codex session, it writes local image paths from `local_images`, `localImages`, or `images` into the user-visible text so refreshes still show which files the user mentioned. If those paths are readable on the current device, have an image MIME type, and are no larger than 5 MB, the executor also creates ready attachments used only for transcript rendering and stores `local_preview_url` as a data URL. This preview attachment is not a persisted Backend attachment, and it is not uploaded or synced to the central database.

Native Codex tasks have one additional rule: transcript refreshes trust only Codex's own session transcript. `runtimeHandle.messages` from a fork package or the executor JSON index is only an import-time snapshot and must not be used as a fallback for native Codex transcripts; otherwise Wework can show stale messages or lose follow-up turns after refresh. Non-SDK native tasks may still use the executor JSON index as their local transcript source.

Assistant messages in a runtime transcript may include a `fileChanges` summary. The Rust executor Codex app-server path uses app-server notifications as the source for turn events. If diff notifications are connected later, `runtime.tasks.create`, `runtime.tasks.send`, and `runtime.tasks.transcript` must normalize them onto the message as `fileChanges`. This lets the frontend show the file changes card under the current assistant message without waiting for the next list refresh.

When Wework renders a file changes card for a runtime LocalTask, it does not call the central Task API. It uses the current task's `deviceId + workspacePath` to execute device commands `turn_file_changes_review` or `turn_file_changes_revert`, so review and revert run in the actual device directory that produced the LocalTask. Runtime LocalTasks may not have central `TaskResource`/`Subtask` rows, so artifact ids may use digit-only paths such as `turn-file-changes/0/<subtaskId>`. The device command must still full-match the artifact id and verify workspace and patch checksum from metadata; it must not accept arbitrary paths. If the local artifact is missing or the revert conflicts, the frontend writes that status back into the current transcript message instead of leaving a stale actionable state on screen.

## Workspace Tool Context

After Wework opens a LocalTask, the right-side file, review, and terminal tools resolve their device and directory from the current LocalTask's device and directory context:

- The LocalTask `workspacePath` returned by `runtime.tasks.list` wins, so a Codex worktree is not treated as a separate Project.
- If the LocalTask maps to a Project, environment info and review still receive that Project, but Git commands run in the LocalTask's actual directory.
- If the LocalTask does not map to a Project, the local terminal can still open as long as the device is online and the directory is accessible. IDE capabilities that depend on Project APIs still require Project context.
- Terminals opened for runtime LocalTasks must start a device-scoped PTY from the current LocalTask's `deviceId + workspacePath` and must not fall back to the Project's default bound device; otherwise cross-device worktrees open on the wrong machine.

The bottom terminal panel state is also scoped to the current workspace-tool context. A terminal opened from LocalTask A must not be reused as LocalTask B's terminal after switching tasks; switching back to A restores A's terminal state. When no LocalTask is selected and only a local Project is selected, the terminal cwd is that Project's local path. In local App mode, missing Backend connectivity must not display a cloud-device prompt or fall back to `$HOME`.

## Create Tasks

Wework creates a new runtime task with:

```text
POST /api/runtime-work/create
```

Backend resolves the target device and directory from either a Project mapping or a standalone device workspace, builds a transient execution request, and calls device RPC `runtime.tasks.create`. This flow does not `db.add()` any `TaskResource` or `Subtask`.

In packaged Wework App `local-first` mode, task creation does not go through the Backend HTTP API. Wework builds the minimal `executionRequest` required by the executor inside the frontend local service from the selected `deviceId + workspacePath`, sends it through a Tauri command to the executor sidecar app IPC channel, and the executor directly runs `runtime.tasks.create`. The payload must include `workspacePath`, the user message, runtime model configuration, and local user context; if no workspace path is available, Wework must fail before calling the executor. This path still uses only the app UI and executor as local processes and does not start a local Backend.

Before calling create, Wework generates a client-side `localTaskId` and sends it to Backend as `localTaskId`. Backend only forwards that value to the target device; it does not write it to the central database. The frontend immediately opens the runtime URL from `deviceId + localTaskId`, renders the user message, and shows the waiting state. If the device returns a different `localTaskId`, the frontend switches to the device-confirmed address. This lets a newly created task appear before the Backend RPC completes or the next list refresh runs, and queued sends wait until the current waiting state becomes a real assistant turn before continuing.

The runtime owns persistence for newly created tasks:

- Claude Code creates an executor JSON LocalTask and stores the transcript and runtime handle in that index.
- Codex creation first returns the Wegent-side `localTaskId` so the frontend can open the task and receive stream events immediately. After app-server `thread/start` and `turn/start` create the real Codex thread, the executor writes the `localTaskId -> threadId` mapping into the JSON LocalTask index for later send/resume calls.
- Codex creation and continuation do not cache the full transcript in the executor JSON index. After an executor restart, the executor recovers task links through Codex app-server `thread/list` plus the local index, then reads transcripts with `thread/read`.
- Codex creation still streams over the LocalTask Responses event channel with `response.created`, text/tool deltas, and `response.completed`/`error`. Those events use the `localTaskId` returned by create, so the frontend does not need to wait for the next list refresh to show the running reply.
- Codex app-server input supports `input_text`, `input_image`, and `localImage` prompt blocks. Backend attachment-id download and sandbox-path rewriting require separate device-side attachment handling; the frontend must not send local attachment paths directly to Backend.
- If Codex response completion includes `file_changes` or `fileChanges`, the executor stores it on the current assistant message's `fileChanges` field, and later transcript refreshes continue to show the same file changes card.

Project-backed creation uses a runtime workspace reference:

- Wework sends a workspace key or an explicitly selected `deviceId + workspacePath`; it does not send a central `projectId`.
- Backend validates the workspace against the current user's online runtime workspace list and resolves the trusted `deviceId + workspacePath`.
- If no project is selected, Wework uses the local device's empty workspace context for a regular conversation; that state has no remote IP and does not write `projectId=0` into the URL.
- Creating a blank project creates a directory under `~/Documents` on the target device. If the name already exists, the frontend must ask the user to rename it instead of treating the existing directory as the project.

Empty projects are runtime-owned as well. After Wework creates or selects a directory, it calls the workspace open/register flow so the executor includes that workspace in the `runtime.tasks.list` project group. The project should be visible even before the directory has any LocalTask or Codex conversation. This flow does not write `TaskResource`, `Subtask`, or Backend `projects` rows.

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

## Projects And Conversations

Wework no longer shows "Unmapped Device Workspaces". Every thread returned by the executor must be grouped into either "Projects" or "Conversations":

- Tasks with `workspaceKind: chat` are shown under "Conversations".
- Other tasks are grouped as "Projects" by workspace name.
- The "Conversations" section is always visible, even when empty, and supports the same collapse and expand interaction as "Projects".

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

New conversation and no-project entry points use the root path or regular conversation path, not placeholder parameters such as `projectId=0`. Project selection state is restored from the runtime workspace reference and the current conversation context.

## Compatibility

Wegent-native Task/Subtask flows remain available for existing chat, shared task, and historical task URL paths. Wework sidebar, mobile drawer, project task display, and new task creation use the runtime work API instead of the DB task list or Backend `projects` table.
