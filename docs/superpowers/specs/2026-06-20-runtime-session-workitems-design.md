---
sidebar_position: 1
---

# Runtime LocalTask Directory Model

## Context

Wework currently treats a Wegent Task as the main conversation object. That
works for Wegent-created tasks, but it does not fit the desired Codex and
Claude Code workflow:

- Users already create native Codex and Claude Code work outside Wework.
- Native runtime work should be visible and continuable in Wework without
  importing historical messages into `subtasks`.
- Local devices should not expose public HTTP endpoints. Backend reaches local
  executors through the existing outbound device WebSocket.
- Future "fork to remote" should let a user continue related work on another
  device or runtime without pretending the center DB owns the runtime lifecycle.
- PR #1501 adds private IM task continuation. Runtime work must be compatible
  with that IM layer, but the IM active target storage has moved to Redis in a
  separate PR and is out of scope for this design.

The model has exactly three user-visible levels:

```text
Cross-device Project
  Device Workspace
    LocalTask
```

The first two levels are central Wegent state. `LocalTask` is device-local
executor metadata.

## Goals

- Store cross-device Project configuration centrally.
- Store per-device workspace mapping centrally.
- Store LocalTasks only in executor/device-local metadata.
- List online Codex and Claude Code work through executor WebSocket RPC.
- Open and render native runtime transcripts without reading or creating
  `tasks/subtasks`.
- Continue native runtime tasks through the same device WebSocket path.
- Support fork-to-remote by creating a related LocalTask on the target device.
- Keep Wegent-native Task/Subtask flows unchanged.
- Keep PR #1501 task IM continuation unchanged.

## Non-Goals

- Do not model native Codex or Claude Code work as Wegent-owned `TaskResource`
  rows.
- Do not store LocalTasks, runtime handles, or transcript paths in the central
  DB.
- Do not introduce a separate SessionBranch entity or UI level.
- Do not add a central short-term runtime task cache.
- Do not implement IM active target persistence. That belongs to the Redis work
  in the other PR.
- Do not require local executors to expose public addresses.
- Do not implement native cross-device session migration. Forking creates a new
  runtime task with transferred context.
- Do not build full statistics, compare, or merge workflows in the first pass.

## Core Concepts

### Project

Project is the cross-device directory. It is user-managed, central Wegent state
and should be stored as a central resource, preferably a `Kind` resource.

Project owns configuration such as:

- display name
- repository identity or logical workspace identity
- default runtime preferences
- access control and sharing metadata
- ordering or pinning in the Project list

Project does not own runtime tasks. Deleting or renaming a Project does not
delete Codex or Claude Code sessions on a user's machine.

### Device Workspace

Device Workspace is the device-level directory mapping. It is central Wegent
state because users need consistent cross-device Project organization.

It answers one question:

```text
For this user and device, which local directory belongs to which Project?
```

Suggested central DB shape:

```ts
interface DeviceWorkspace {
  id: number
  userId: number
  projectId: number
  deviceId: string
  workspacePath: string
  repoUrl?: string
  repoRootFingerprint?: string
  label?: string
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}
```

This is not a task table. It has no `local_task_id`, transcript path, resume
token, or runtime handle.

### LocalTask

LocalTask is the task level under a Device Workspace shown by Wework. It is
executor-local metadata, scoped under that local directory.

```text
Project: Wegent
  Device Workspace: MacBook /repo/Wegent
    LocalTask: Fix websocket reconnect
```

LocalTask metadata lives on the device, for example in executor local SQLite:

```text
~/.wegent/runtime-work/index.sqlite
```

Suggested local shape:

```ts
interface LocalTask {
  localTaskId: string
  workspacePath: string
  title: string
  runtime: 'codex' | 'claude_code'
  runtimeHandle: unknown
  parent?: RuntimeTaskAddress
  children?: RuntimeTaskAddress[]
  createdAt: string
  updatedAt: string
  running: boolean
  status?: 'active' | 'archived'
}
```

`runtimeHandle` is opaque outside the owning executor. For Codex it may contain
a Codex native thread/session locator. For Claude Code it may contain a Claude
session locator. Backend and Wework pass it back to the owning executor and do
not infer lifecycle from it.

Fork and migration relationship metadata is stored inline on LocalTask:

- The target device creates a new LocalTask with `parent` pointing to the source.
- If the source device is online, it may record the target in `children`.
- Parent/child metadata is local executor metadata, not central DB state.

LocalTask must not contain:

- central `project_id`
- transcript path
- IM active target

Project grouping is inferred by matching the LocalTask's Device Workspace to the
central Device Workspace mapping.

### Runtime Task Address

Backend and Wework need a transport address for operations, but this address is
not persisted centrally as task state.

```ts
interface RuntimeTaskAddress {
  deviceId: string
  workspacePath: string
  localTaskId: string
}
```

The address comes from executor list results. It can be placed in transient UI
state or in Redis IM active target state owned by the IM PR, but it is not a
central DB task record.

## Communication Model

Executor does not expose HTTP. It keeps the existing outbound WebSocket
connection to Backend. Backend sends typed RPC messages over that device
channel:

```ts
type RuntimeRpc =
  | 'runtime.tasks.list'
  | 'runtime.tasks.transcript'
  | 'runtime.tasks.create'
  | 'runtime.tasks.send'
  | 'runtime.tasks.cancel'
  | 'runtime.tasks.status'
  | 'runtime.tasks.fork_package'
```

The browser talks only to Backend through Wework's normal REST and Socket.IO
surface.

For IM continuation, the existing IM Redis active-target flow should store a
runtime target payload equivalent to `RuntimeTaskAddress`. Runtime providers do
not talk to IM providers directly. They receive normalized source metadata from
Backend when an IM message is routed to `runtime.tasks.send`.

```ts
interface MessageSource {
  source: 'im'
  external_id: string
  channel_type: string
  channel_id: number
  conversation_id: string
  sender_id: string
  message_id?: string
}
```

Executor may store source metadata in its local runtime metadata store so that
transcript responses can overlay IM source badges onto normalized messages.
Native Codex and Claude Code transcript files remain authoritative for message
bodies.

## Frontend Interaction

The sidebar renders the exact three-level model:

```text
Projects
  Wegent
    MacBook /repo/Wegent
      Fix websocket reconnect
      Refactor runtime RPC
    Linux /workspace/Wegent
      Fork: websocket reconnect

Unmapped Device Workspaces
  MacBook /tmp/spike
    Untitled Codex work
```

Rules:

- Projects come from central Project resources.
- Device Workspaces come from the central Device Workspace mapping.
- LocalTasks come from online executors only.
- If a Device Workspace is offline, Wework can show the workspace as offline but
  must not invent or keep central LocalTasks.
- Unmapped local directories can be shown from executor discovery, then mapped
  to a Project by creating a central Device Workspace row.
- Opening a LocalTask opens that task's native runtime transcript.
- Runtime and parent/child information is shown in the LocalTask details, not as
  another tree level.

## Data Flows

### List Work

1. Wework asks Backend for runtime workbench data.
2. Backend reads central Projects and Device Workspaces for the user.
3. Backend sends `runtime.tasks.list` to each online owned device.
4. Executor reads local metadata and native runtime discovery, then returns
   Device Workspace summaries and LocalTasks.
5. Backend groups returned LocalTasks under central Device Workspaces by
   `deviceId + workspacePath`.
6. Wework renders Projects -> Device Workspaces -> LocalTasks.

Offline devices do not contribute LocalTasks. There is no central runtime task
cache.

### Map A Device Workspace

1. User chooses an unmapped local directory returned by an executor.
2. User selects or creates a Project.
3. Backend creates or updates the central Device Workspace mapping.
4. Existing LocalTasks under that directory now appear under the Project.

No LocalTask metadata is modified for this operation.

### Open A LocalTask

1. User selects a LocalTask.
2. Backend sends `runtime.tasks.transcript` to the owning device with the
   `RuntimeTaskAddress`.
3. Executor resolves the LocalTask, reads the native runtime transcript, and
   returns normalized messages.
4. Wework renders messages from the transcript response.

No `TaskDetail.subtasks` call is used for this path.

### Continue A LocalTask

1. User sends a message in an open LocalTask.
2. Backend sends `runtime.tasks.send` with the `RuntimeTaskAddress`, message, and
   optional source metadata.
3. Executor resolves the LocalTask and resumes the native runtime session using
   its opaque runtime handle.
4. Executor streams normalized events back through the device WebSocket.
5. Backend forwards those events to the Wework client.

No Task or Subtask is created for this runtime-native turn.

### Continue In IM

This design does not implement IM active target storage. The other PR owns the
Redis state.

Compatibility requirement:

- Wework can pass a runtime target payload equivalent to `RuntimeTaskAddress` to
  the IM active-target API from that PR.
- When a private IM message targets runtime work, Backend routes it through
  `runtime.tasks.send`.
- Executor receives normalized IM source metadata and stores any source overlay
  locally.
- Legacy PR #1501 task continuation remains unchanged.

### Fork To Remote

Forking is a semantic fork, not native session migration.

1. User clicks `Fork to...` on a LocalTask.
2. User selects target device and target Device Workspace.
3. Backend requests `runtime.tasks.fork_package` from the source executor.
4. Source executor returns a bounded package:

```ts
interface ForkPackage {
  sourceRuntime: 'codex' | 'claude_code'
  title: string
  summary: string
  recentMessages: NormalizedMessage[]
  workspaceState?: {
    gitRemote?: string
    gitBranch?: string
    baseCommit?: string
    diffPatch?: string
    includeUntracked?: boolean
  }
}
```

5. Backend sends `runtime.tasks.create` to the target executor with the package
   and source `RuntimeTaskAddress`.
6. Target executor creates a new LocalTask with a local runtime handle and
   inline `parent` metadata.
7. If the source executor is online, Backend may ask it to record a child hint in
   the source LocalTask. This is best-effort local metadata, not central DB
   state.
8. Wework opens the new LocalTask.

## Error Handling

- Device offline: show the Device Workspace as offline and disable open/send/fork
  for LocalTasks on that device.
- LocalTask missing: refresh that device's runtime work list.
- Transcript parse failure: show a partial transcript if possible and record the
  parse error in the UI.
- Runtime send failure: keep the current LocalTask open and display the runtime
  error without creating a failed Subtask.
- Fork target unavailable: keep the source LocalTask active and let the user pick
  a different target.
- Device Workspace path missing on target: prompt for another path or create the
  directory through an explicit device action.

## Security

- The browser never sends shell commands.
- Backend dispatches only typed runtime RPC over an authenticated device
  WebSocket.
- Runtime RPC validates device ownership and workspace membership.
- Executor validates that `localTaskId` belongs to the requested workspace before
  using a runtime handle.
- Transcript responses should be size-limited and paginated for large sessions.
- Fork packages should cap recent message count and diff size.
- IM provider handlers must not call runtime providers directly. DingTalk,
  Telegram, Discord, and future IM providers continue through the shared IM
  interaction layer.

## Testing

- Backend tests cover central Project listing.
- Backend tests cover Device Workspace create/update/list by
  `userId + deviceId + workspacePath`.
- Backend tests cover grouping executor-returned LocalTasks under Device
  Workspaces without central LocalTask rows.
- Backend tests cover runtime RPC dispatch only to online owned devices.
- Backend tests verify no TaskResource/Subtask is created for runtime-native
  open/send flows.
- Executor tests cover local LocalTask metadata persistence.
- Executor tests cover Codex list/transcript/send through the unified RPC.
- Executor tests cover Claude Code list/transcript/send through the unified RPC.
- Executor tests cover fork package creation and local parent/child metadata.
- Executor tests cover local source metadata overlay onto normalized runtime
  transcript messages.
- Wework tests cover Project -> Device Workspace -> LocalTask rendering.
- Wework tests cover unmapped local directory mapping into a Project.
- Wework tests cover opening a runtime transcript without calling task detail.
- Wework tests cover disabled actions for offline devices.
- Wework tests cover rendering IM source badges for runtime transcript messages
  when source metadata is present.

## POC Sequence

1. Add central Project resource support if the existing product Project resource
   is not sufficient.
2. Add central Device Workspace mapping APIs.
3. Add executor local metadata store for LocalTask.
4. Add runtime task RPC over the existing device WebSocket.
5. Implement Codex list/transcript/send through the new RPC.
6. Implement Claude Code list/transcript/send through the same RPC.
7. Add Backend aggregation APIs for Project -> Device Workspace -> LocalTask
   data.
8. Update Wework sidebar and open-task state to use runtime task data.
9. Add map-device-workspace-to-Project.
10. Add fork-to-remote.
11. Add runtime target payload compatibility for the Redis-based IM active-target
    flow from the other PR.
