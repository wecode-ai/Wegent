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

Codex tasks are discovered and controlled through the `codex app-server --stdio` JSON-RPC protocol. The executor stores the Wegent `localTaskId`, workspace, title, status, and real Codex `threadId` mapping in its local index so app-mode task creation can recover after a restart. The full transcript remains authoritative in the Codex app-server `thread/read` metadata plus the local rollout JSONL and is not synced to the central database.

`localTaskId` is the Wegent-side local task identity, not the provider runtime's session id. When the frontend, Backend, and executor need to pass provider session identity, they must use the opaque `runtimeHandle`, such as a Codex `threadId`, Claude Code `sessionId`, or OpenCode `sessionId`, or an explicit `providerSessionId`. `runtime.tasks.transcript` must not treat `localTaskId` as a provider session id when there is no LocalTask index mapping and no `runtimeHandle`; optimistic tasks that are still being created should return an empty local transcript until create/link completes.

## List Refresh

Wework requests the task list on startup, explicit refresh, or device-state changes. It no longer refreshes the list through a fixed polling interval.

1. Wework requests `GET /api/runtime-work`.
2. Backend reads the current user's online devices and calls `runtime.tasks.list` over each device WebSocket RPC channel.
3. The executor refreshes local Codex threads through persistent Codex app-server `thread/list` calls and merges the device-side JSON LocalTask index.
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

Backend fans out `runtime.tasks.search` only to the current user's online or busy devices. It does not read central `TaskResource`, `Subtask`, or cached history rows. The executor searches local task titles and transcripts, then returns snippets, message metadata, update time, device name, workspace path, and the transient task address. For Codex history threads, the transient task address must include `runtimeHandle.threadId` so opening a search result can load the original conversation through the transcript RPC without depending on a matching link already existing in the local task index.

Search results are merged by `updatedAt` descending and capped by the request `limit`. `includeArchived` is passed to the executor so it can decide whether archived LocalTasks are included. When the request includes `projectId`, Backend derives the Project from each workspace path and only returns results under that Project; `workspaceKind: chat` Conversation results have no Project owner.

The frontend search dialog opens the runtime address from the result, then restores workspace context from the latest runtime work list. The dialog only keeps recent query results in memory to avoid repeating the same RPC while the dialog is open; cached results are not written to Backend and do not replace executor-side transcript reads.

## Open And Continue

When a user opens a LocalTask, Wework calls Backend:

```text
POST /api/runtime-work/transcript
```

Backend forwards `deviceId + localTaskId` to the owning device with `runtime.tasks.transcript`. Native Codex tasks are located through their Codex session path or session-file discovery. Non-Codex/imported tasks may use `workspacePath` as a local-index lookup hint, or locate the task from the local LocalTask index by `localTaskId`. The executor reads the native runtime transcript and returns normalized messages.

### Codex Transcript Read Path And Performance

Wework uses one primary read path for local Codex conversations so list, open, and refresh do not each implement separate transcript logic:

1. The list path calls persistent Codex app-server `thread/list` with `recency_at` descending sort, the `archived` filter, and `useStateDbOnly` to read thread metadata without scanning JSONL transcripts. The executor keeps a small-window cache for repeated list requests, invalidates it after thread-management operations or local task state changes, then merges the device-side LocalTask index.
2. The first open path calls `thread/read` with `includeTurns: false`, which returns thread metadata and the rollout path only. The executor then parses that JSONL once, builds normalized messages, tool blocks, thinking blocks, file changes, and raw rollout turns, and stores them in memory with the rollout length/mtime signature.
3. Switching to an already loaded conversation no longer calls Codex app-server or rereads the file. The executor serves the full message array from memory and applies the requested `limit`/`beforeCursor` page.
4. When a switch needs fresh data, the executor first reads the current rollout file signature. If the file only appended bytes, it reads from the previous length, applies those events to the cached rollout turns, regenerates messages only from the first affected turn, and replaces the cached tail by `turnId`. Tool items, thinking, running status, and new text all come from that single append result.
5. The only recovery path is a non-append file change: truncation, same-length mtime changes, or an old cache without raw turns. In that case the executor discards the cache and runs the first-open path again.

The list, read, and thread-management paths share one persistent Codex app-server connection, avoiding per-RPC child process startup. Wework still does not use Codex app-server `thread/turns/list` for long transcript paging because the current Codex implementation still replays the whole rollout file on each request. That has the same cost as a full read and cannot reuse the executor's normalized tool/message cache. Opening with `includeTurns: true` is also avoided because large transcripts would be serialized through app-server before the executor normalizes them, increasing IPC and frontend pressure.

Use this manual benchmark to recheck a local rollout:

```bash
cd executor
WEGENT_MANUAL_ROLLOUT=/path/to/rollout.jsonl \
WEGENT_MANUAL_APPEND=1 \
cargo test --test manual_runtime_perf -- --ignored --nocapture
```

Current local measurements:

| Sample                                  | File size   |  List | First open | Loaded switch | Append refresh |
| --------------------------------------- | ----------- | ----: | ---------: | ------------: | -------------: |
| "Fix running task tool calls not shown" | about 61 MB | 13 ms |     2.09 s |         33 ms |          53 ms |

The current target is therefore met: list under 1 second, first open under 3 seconds, and loaded switch plus fresh-data refresh under 500 ms. The first cold parse for even larger extreme histories is still bounded by JSONL size, but loaded switching and append refresh no longer grow with total history length.

When a user continues a LocalTask, Wework calls:

```text
POST /api/runtime-work/send
```

Backend forwards `runtime.tasks.send`. The executor resumes the runtime session from the local LocalTask's opaque runtime handle. Codex tasks use the saved `threadId` to call app-server `thread/resume`, then send the new turn with `turn/start`. Messages and status come from the Codex thread transcript; the executor JSON index stores task-link metadata only. Streaming Responses events carry the current LocalTask `local_task_id`, the turn `task_id`, and `subtask_id`; the Wework entry layer maps the local task into the unified task identity and treats `subtask_id` as the turn identity for the message reducer, without a separate `message_id`. These events do not carry `workspacePath`.

Before `turn/start`, the executor starts a watchdog for the first meaningful progress event so a Codex turn that stalls during startup, such as MCP initialization, cannot leave Wework showing "Thinking" forever. The default timeout is 180 seconds and can be adjusted with `WEGENT_CODEX_TURN_STARTUP_TIMEOUT_SECONDS`. A user-input echo, an error marked for retry, or a subagent event does not count as progress. The watchdog is disabled as soon as the first assistant, reasoning, or tool item arrives, so a long-running tool that has already started is not terminated. When startup times out, the executor stops the stalled shared app-server, completes the current turn with an explicit error, and starts a new process when the user retries or sends another message. Wework must preserve the original user message and failure card, and retry the exact input associated with the failed turn instead of leaving a blank assistant message or sending an older prompt.

To diagnose a reply whose text is complete while the sidebar and composer still show a running state, correlate packaged-app logs by the same `deviceId + taskId + subtaskId`. Tauri first records receiving and forwarding `response.completed`, `response.failed`, or `response.incomplete`; the local chat stream then records how many subscriptions matched the terminal event; the pane layer records whether it accepted the terminal event or dropped it because the task or device did not match; finally, Workbench Provider records dispatch of `runtime_task_settled`. These entries contain only runtime identities, event types, and block counts, never response content or credentials. The first missing entry identifies the boundary before which terminal-state propagation stopped.

Every continuation request must carry the current model selection. The Wework model selector is the source of truth for the turn being sent: whichever model the user selects for that turn becomes the `modelId`, `modelType`, and model options in `runtime.tasks.send`. The executor must not restore a model from a previous request and must not cache model selection. If a request has neither a full `executionRequest` nor a `modelId`, the executor must return `bad_request` instead of falling back to a default model. In packaged local app mode, `createLocalAppServices()` is the single boundary that normalizes local Codex model names: the UI may display `codex-gpt-5.5`, but the value sent to Codex app-server must be the real model id `gpt-5.5`. Task creation and continuation must reuse that same normalization path.

If the current LocalTask is still replying, Wework queues new user input locally instead of sending concurrent `runtime.tasks.send` calls. Users can remove queued messages, or choose to stop the current reply and send the queued message from the queue panel. That first calls:

```text
POST /api/runtime-work/cancel
```

Backend forwards `deviceId + localTaskId` as `runtime.tasks.cancel`. The Rust executor Codex app-server path currently does not interrupt an in-flight turn across processes, so app mode returns `accepted: false`; the frontend should keep the queued state or wait for the current turn to finish. If `turn/interrupt` support is added later, it must still identify the task only by `deviceId + localTaskId`; `workspacePath` remains device-directory context.

When the current Codex LocalTask is still replying, Wework can also send a queued user message as native guidance:

```text
POST /api/runtime-work/guidance
```

Backend only validates the user, device, and LocalTask ownership, then forwards `deviceId + localTaskId`, the user text, and the frontend-generated `clientGuidanceId` as device RPC `runtime.tasks.guidance`. The executor must find the running Codex turn and append the user text through Codex app-server's native guidance capability. If there is no active turn to guide, it should return `no_active_turn`; the frontend then sends the same message as a regular follow-up. `runtime.tasks.guidance` does not create central Task or Subtask rows, and it must not use `workspacePath` as task identity.

The frontend must insert the local guidance user message at the current streaming assistant position immediately when guidance sending starts, not after `runtime.tasks.guidance` returns. That insertion splits the active assistant into a frozen "before guidance" message and a continuing "after guidance" message. The continuing assistant keeps the original `subtaskId` so later stream events land after the guidance message. Later `chat:chunk` or `chat:done` events may still carry full text, so the frontend trims the text prefix recorded at split time. This keeps live streaming order consistent with the refreshed transcript order.

Users can also manually compact a local Codex LocalTask from the composer's context-usage control:

```text
runtime.tasks.compact
```

The Wework App calls `runtime.tasks.compact` only through local executor IPC; there is no Backend HTTP endpoint for this action. The executor must use the LocalTask's opaque `runtimeHandle.threadId` to call Codex app-server `thread/resume`, then call `thread/compact/start`; it must not send `/compact` as a normal user message. Manual compaction uses an independent runtime subtask id, `<localTaskId>-context-compact`, so the UI can render the `context_compaction` tool block as its own completed message without settling an active assistant turn.

If the current pane is still replying, Wework should block manual compaction and ask the user to wait for the current reply to finish. Automatic Codex context compaction remains part of the current turn's subtask; the frontend may display the `context_compaction` block, but it must not emit `assistant_done` or settle the current reply just because that block completed.

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
POST /api/runtime-work/archived-conversations/cleanup-preview
POST /api/runtime-work/archived-conversations/cleanup
```

For native Codex conversations, the executor archives, unarchives, and deletes through app-server `thread/archive`, `thread/unarchive`, and `thread/delete`; renaming uses `thread/name/set`. Archived lists come from the state DB `threads.archived` filter and are merged with the JSON LocalTask index. List responses normalize `id`, `localTaskId`, `threadId`, title, Project name, workspace path, device, source, and timestamp fields, and include grouped Project counts. Immediately after archive or unarchive, the local override from the device-side LocalTask index participates in the list if the state DB has not caught up yet, so the UI does not briefly lose the item. Project grouping must use the Project root or `groupWorkspacePath`; different worktrees under the same Project must not appear as separate Projects.

If Codex `thread/list` returns a dirty state DB thread whose rollout file can no longer be located, `thread/archive` returns `no rollout found for thread id ...`. The executor treats only that explicit error as cleanup: it calls Codex `thread/delete` to remove the leftover thread record and writes a local deleted marker with TTL and count limits, so later lists no longer show the unusable record. It does not pretend that dirty thread became an archived conversation.

Deleting archived conversations uses a two-phase strategy. Foreground `delete` and `delete-bulk` first write an executor-local tombstone so the item disappears from lists immediately. The actual Codex `thread/delete`, LocalTask index deletion, and worktree/attachment/log file cleanup run one item at a time in an executor background worker. The worker must wait for the current app-server `thread/delete` to finish before starting the next one. If a delete is slow, it records a slow-operation log instead of using a client-side timeout to stack more `thread/delete` calls; otherwise Codex thread store pressure can make archived list refreshes wait for a long time. The frontend submits bulk deletes in small batches and stores progress outside the page component, so leaving and re-entering Settings still shows the current delete progress.

`cleanup-preview` and `cleanup` only target leftover files for archived LocalTasks, including executor-managed Git worktree directories, LocalTask records, session logs, local attachments recorded in the runtime handle, and local attachment draft paths. Cleanup targets must be derived from the archived item's `deviceId + workspacePath + localTaskId + threadId/runtimeHandle` and pass path-safety checks. The executor may delete only files under managed executor directories, standalone chat directories, or local attachment draft directories. It must not clean regular Project roots, unarchived conversations, running tasks, or archived items that the frontend did not submit.

When the archived LocalTask uses an Executor-managed Git worktree, Wework calls the device-scoped `runtime.worktrees.delete` after archive succeeds. The Executor writes tracked, staged, unstaged, and non-ignored untracked files to a hidden `refs/wegent/worktree-snapshots/*` reference before Git removes the worktree. A snapshot failure must preserve the directory and return an error; uncommitted changes must not be discarded. When a task is unarchived or receives another message after its directory was cleaned, the Executor restores the original path from the snapshot reference. This lifecycle applies only to runtime LocalTask worktrees and does not mutate the Project root workspace.

### Worktree settings and lifecycle

Worktree settings are device-scoped state persisted in `$WEGENT_EXECUTOR_HOME/runtime-work/worktrees.json`; they do not belong in browser preferences or Backend user settings. An empty configured root resolves to the current Executor workspace `worktrees` directory. Automatic cleanup is enabled by default and retains 15 worktrees. Changing the root affects only future worktrees. Previous roots remain in `knownRoots` so existing worktrees can still be listed, restored, and cleaned safely.

Wework manages worktrees through device-scoped `runtime.worktrees.settings.get/update` and `runtime.worktrees.prepare/list/delete/restore/prune` RPCs. Creation targets are fixed to `<resolvedRoot>/<worktreeId>/<repositoryName>`. Lists are grouped by repository and include linked LocalTasks. Deletion archives linked tasks and captures a snapshot first. Automatic cleanup runs after creation and settings updates and only removes least-recently-used worktrees above the retention limit when they are explicitly linked exclusively to archived tasks. Worktrees without a task record in the current Executor are never auto-cleaned. Continuing a cleaned task restores it on demand. Isolated Executor instances derive their default worktree directory from their own `WEGENT_EXECUTOR_HOME`, preventing test or development instances from managing production worktrees.

The Project actions menu can create a permanent worktree from the current Git workspace `HEAD` and immediately register the new directory as a separate Project. These requests pass `permanent: true` through `runtime.worktrees.prepare`; the Executor persists the flag in `worktrees.json`, and automatic cleanup candidate selection must exclude permanent worktrees. Permanent means the worktree is not removed automatically because linked tasks were archived or the retention limit was exceeded; users can still delete it explicitly through Project removal or worktree management.

In packaged Wework App `local-first` mode, pasted or selected files are saved under the executor home attachment draft directory (`$WEGENT_EXECUTOR_HOME/workspace/attachments/draft` when configured, otherwise `~/.wegent-executor/workspace/attachments/draft`) and sent to the executor as local `attachments`, not as Backend `attachmentIds`. Image attachments keep `local_preview_url` so the sent message can preview the file immediately through the Tauri asset protocol, and Codex receives the same path as a `localImage` input. Text-like local attachments are not injected in full; the executor adds only a bounded preview of the first 10 lines or 4 KiB, whichever comes first, plus the `Local File Path` so Codex can read the full file when needed. Wework keeps `text_length` and `text_preview` on local attachment metadata so refreshes can still render compact text-preview attachments; in the Tauri App, clicking that attachment opens the original local file through the `open_local_file` command. When Wework is connected to Backend and uses uploaded attachments, persisted attachment ids remain the source of truth after refresh.

When rendering a message that already has persisted image attachments, Wework prefers those attachment previews and ignores local image file mentions embedded in the Codex prompt. This avoids showing both the uploaded attachment and a temporary local path. Codex local image mentions are used only as a same-device preview fallback when no attachment record exists. If the current environment cannot convert the local path through Tauri `convertFileSrc`, or the converted image fails to load, the frontend does not display that local path.

When the executor discovers a user message from a native Codex session, it writes local image paths from `local_images`, `localImages`, or `images` into the user-visible text so refreshes still show which files the user mentioned. If those paths are readable on the current device, have an image MIME type, and are no larger than 5 MB, the executor also creates ready attachments used only for transcript rendering and stores `local_preview_url` as a data URL. This preview attachment is not a persisted Backend attachment, and it is not uploaded or synced to the central database.

Native Codex tasks have one additional rule: transcript refreshes trust only Codex's own session transcript. `runtimeHandle.messages` from a fork package or the executor JSON index is only an import-time snapshot and must not be used as a fallback for native Codex transcripts; otherwise Wework can show stale messages or lose follow-up turns after refresh. Non-SDK native tasks may still use the executor JSON index as their local transcript source.

Assistant messages in a runtime transcript may include a `fileChanges` summary. The Rust executor Codex app-server path uses app-server notifications as the source for turn events. If diff notifications are connected later, `runtime.tasks.create`, `runtime.tasks.send`, and `runtime.tasks.transcript` must normalize them onto the message as `fileChanges`. This lets the frontend show the file changes card under the current assistant message without waiting for the next list refresh.

Historical transcripts consistently use `subtaskId` to identify an assistant message's subtask, but Backend-forwarded cloud task IDs are numbers while local executor turn IDs are strings. Wework must normalize both value types to strings at the restoration mapping boundary because tool-call blocks and file-change blocks depend on that identity and must not disappear because of its transport type.

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

For Project-backed task creation, Wework has only two execution workspace sources: `current_workspace` uses the Project root, while `git_worktree` calls `runtime.worktrees.prepare` on the target device. The path is derived from that device's Worktree settings, runtime task id, and Project directory name; the UI must not compose arbitrary target paths. A worktree create request may carry an explicit `branch`. When no branch is provided, the default branch must be the current Git branch of the Project root, not the Git default branch and not a `HEAD` label. The branch list is only a selectable display surface: the current branch should be first, and the remaining branches should preserve Git's returned order.

Before calling create, Wework generates a client-side `localTaskId` and sends it to Backend as `localTaskId`. Backend only forwards that value to the target device; it does not write it to the central database. The frontend immediately opens the runtime URL from `deviceId + localTaskId`, renders the user message, and shows the waiting state. If the device returns a different `localTaskId`, the frontend switches to the device-confirmed address. This lets a newly created task appear before the Backend RPC completes or the next list refresh runs, and queued sends wait until the current waiting state becomes a real assistant turn before continuing.

The runtime owns persistence for newly created tasks:

- Claude Code creates an executor JSON LocalTask and stores the transcript and runtime handle in that index.
- Codex creation first returns the Wegent-side `localTaskId` so the frontend can open the task and receive stream events immediately. After app-server `thread/start` and `turn/start` create the real Codex thread, the executor writes the `localTaskId -> threadId` mapping into the JSON LocalTask index for later send/resume calls.
- Codex creation and continuation do not cache the full transcript in the executor JSON index. After an executor restart, the executor recovers task links through `thread/list` plus the local index, then reads transcripts from `thread/read` metadata plus rollout JSONL.
- Codex creation still streams over the LocalTask Responses event channel with `response.created`, text/tool deltas, and `response.completed`/`error`. Those events use the `localTaskId` returned by create, so the frontend does not need to wait for the next list refresh to show the running reply.
- Codex app-server input supports `input_text`, `input_image`, and `localImage` prompt blocks. Backend attachment-id download and sandbox-path rewriting remain separate from local-first attachments: local App mode sends same-device attachment records through executor IPC, while cloud/Backend paths continue to use uploaded attachment ids.
- If Codex response completion includes `file_changes` or `fileChanges`, the executor stores it on the current assistant message's `fileChanges` field, and later transcript refreshes continue to show the same file changes card.
- Codex app-server `imageGeneration` items must not be treated as ordinary text tool output. The executor stores the complete image result in the tool block `render_payload`, together with the revised prompt and generated-file path, and Wework renders the image directly from that payload. Image data must bypass the regular tool-output truncation window or the base64 will be corrupted during live display or transcript restoration.

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
