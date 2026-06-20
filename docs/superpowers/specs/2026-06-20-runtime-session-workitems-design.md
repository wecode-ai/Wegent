---
sidebar_position: 1
---

# Runtime Session WorkItems

## Context

Wework currently treats a Wegent Task as the main conversation object. That
works for Wegent-created tasks, but it does not fit the desired Codex and
Claude Code workflow:

- Users already create native Codex and Claude Code sessions outside Wework.
- Those sessions should be visible and continuable in Wework without importing
  historical messages into `subtasks`.
- Local devices should not expose public HTTP endpoints. Backend must reach
  executor through the existing outbound device WebSocket.
- Future "fork to remote" should let a user continue the same work on another
  device or runtime while keeping source and forked sessions related.

The new model separates product identity from runtime storage. Wegent stores
projects, work items, and runtime branch references. Codex and Claude Code keep
their native transcript history.

## Goals

- Let Wework list online Codex and Claude Code native sessions through executor
  WebSocket RPC.
- Open and render native session transcripts without reading or creating
  `tasks/subtasks`.
- Continue a native session through the same device WebSocket path.
- Introduce a lightweight `WorkItem` as the stable product object for a piece
  of work inside a Project.
- Attach one or more runtime session branches to a WorkItem.
- Support "fork to remote" as a semantic fork into a new runtime session on a
  target device/runtime/path.
- Keep user, device, authentication, Project, ProjectLocation, WorkItem, and
  SessionBranch state in Backend DB.

## Non-Goals

- Do not remove the existing Task/Subtask pipeline for Wegent-native chats in
  this POC.
- Do not import full Codex or Claude Code history into `subtasks`.
- Do not require local executors to expose public addresses.
- Do not implement native cross-device session migration. Forking creates a new
  runtime session with transferred context.
- Do not build full statistics, branch compare, or merge workflows in the first
  pass.

## Core Concepts

### Project

A Project is a logical Wegent project. It may span multiple devices and
runtimes.

### ProjectLocation

A ProjectLocation maps a Project to one concrete runtime working directory:

```ts
interface ProjectLocation {
  id: number
  projectId: number
  deviceId: string
  runtime: 'codex' | 'claude_code'
  path: string
  label?: string
  isPrimary: boolean
}
```

The tuple `(project_id, device_id, runtime, path)` should be unique.

### WorkItem

A WorkItem is the stable product identity for a piece of work under a Project.
It is not a transcript store.

```ts
interface WorkItem {
  id: number
  projectId: number
  title: string
  status: 'active' | 'archived' | 'completed'
  activeBranchId?: number
  createdAt: string
  updatedAt: string
}
```

### SessionBranch

A SessionBranch connects a WorkItem to one native runtime session.

```ts
interface SessionBranch {
  id: number
  workItemId: number
  deviceId: string
  runtime: 'codex' | 'claude_code'
  sessionId: string
  path: string
  parentBranchId?: number
  relation: 'origin' | 'fork'
  createdAt: string
  updatedAt: string
}
```

SessionBranch stores identity and lineage. Message bodies remain in Codex or
Claude Code transcript files.

### RuntimeSession

RuntimeSession is the online executor's view of a native session:

```ts
interface RuntimeSession {
  deviceId: string
  runtime: 'codex' | 'claude_code'
  sessionId: string
  title: string
  cwd?: string
  updatedAt?: string
  running: boolean
  transcriptAvailable: boolean
}
```

RuntimeSession is not persisted as the source of truth. Backend can match it to
SessionBranch by `(device_id, runtime, session_id)`.

## Communication Model

Executor does not expose HTTP. It keeps the existing outbound WebSocket
connection to Backend. Backend sends typed RPC messages over that device
channel:

```ts
type RuntimeRpc =
  | 'runtime.sessions.list'
  | 'runtime.sessions.transcript'
  | 'runtime.sessions.create'
  | 'runtime.sessions.send'
  | 'runtime.sessions.cancel'
  | 'runtime.sessions.status'
  | 'runtime.sessions.fork_package'
```

The browser only talks to Backend through Wework's normal REST and Socket.IO
surface.

```text
Wework Frontend
  -> Backend REST / Socket.IO
    -> Device WebSocket RPC
      -> Local Executor
        -> Codex / Claude Code files and CLI/SDK
```

## Runtime Feasibility

### Codex

Codex already has a local discovery command in the codebase
(`codex_threads_list`). The POC should generalize this into the runtime session
RPC shape instead of binding Codex threads to Wegent Tasks.

### Claude Code

Claude Code is feasible for the same model:

- `claude --resume <session-id>` resumes a specific session.
- `claude --continue` continues the latest session in the current directory.
- `claude -p --resume <session-id> --output-format=stream-json` can stream a
  non-interactive turn.
- Local transcript files are JSONL under the Claude Code home/project session
  storage.
- Session metadata includes session id and working directory.
- The existing Wegent Claude Code executor already carries a `resume` option
  into Claude SDK options and saves returned session ids.

The POC needs to add Claude Code session listing and transcript normalization.

## Frontend Interaction

The primary UI model is:

```text
Project
  WorkItem
    SessionBranch
```

The sidebar should be project-first, with a local-session fallback:

```text
Projects
  Wegent
    Fix websocket reconnect
      MacBook · Codex
      Linux · Claude Code · fork
    Refactor runtime RPC
      MacBook · Claude Code

Local Sessions
  MacBook
    Unmatched
      Codex · untitled session
      Claude Code · investigate history
```

Rules:

- Matched sessions appear under Project -> WorkItem.
- Unmatched native sessions appear under Local Sessions.
- Opening an unmatched session does not require creating a WorkItem first.
- The open view offers `Attach to Project` and `Fork to...`.
- Attaching creates a WorkItem and an origin SessionBranch.
- Forking creates a new SessionBranch under the same WorkItem.
- Forking from an unmatched session first asks the user to create or choose the
  WorkItem that will own the source and target branches.

The main header should show the work identity and active runtime branch:

```text
Fix websocket reconnect
Wegent · MacBook · Codex · ~/repo/Wegent
[Fork to...] [Attach] [Open terminal] [Refresh]
```

For a fork:

```text
Fix websocket reconnect
Wegent · Linux · Claude Code · /workspace/Wegent
Forked from MacBook · Codex
[Switch branch] [Fork to...] [Compare]
```

## Data Flows

### List Sessions

1. Wework asks Backend for runtime workbench data.
2. Backend reads user devices and Project/ProjectLocation/WorkItem/SessionBranch
   data from DB.
3. Backend sends `runtime.sessions.list` to each online executor device.
4. Executor returns Codex and Claude Code RuntimeSession summaries from its
   local cache.
5. Backend matches RuntimeSessions to SessionBranches and ProjectLocations.
6. Wework renders matched sessions under Projects and unmatched sessions under
   Local Sessions.

Offline devices do not contribute RuntimeSessions. Persisted WorkItems and
SessionBranches can still be shown as unavailable if useful.

### Open Session

1. User selects a RuntimeSession or SessionBranch.
2. Backend sends `runtime.sessions.transcript` to the owning device.
3. Executor reads the local runtime transcript and returns normalized messages.
4. Wework renders messages from the transcript response.

No `TaskDetail.subtasks` call is used for this path.

### Continue Session

1. User sends a message in an open RuntimeSession.
2. Backend sends `runtime.sessions.send` with `device_id`, `runtime`,
   `session_id`, `path`, and message.
3. Executor resumes the native runtime session:
   - Codex resumes the Codex thread id.
   - Claude Code resumes the Claude session id.
4. Executor streams normalized events back through the device WebSocket.
5. Backend forwards those events to the Wework client.

No Task or Subtask is created for this runtime-native turn.

### Attach Session To Project

1. User opens an unmatched local session.
2. User chooses Project and optionally an existing WorkItem.
3. Backend creates a WorkItem if needed.
4. Backend creates an origin SessionBranch for the runtime session.
5. The session moves from Local Sessions into Project -> WorkItem.

### Fork To Remote

Forking is a semantic fork, not native session migration.

1. User clicks `Fork to...` on a SessionBranch or RuntimeSession.
2. User selects target device, runtime, and ProjectLocation/path.
3. Backend requests `runtime.sessions.fork_package` from the source executor.
4. Source executor returns a bounded package:

```ts
interface ForkPackage {
  sourceRuntime: 'codex' | 'claude_code'
  sourceSessionId: string
  title: string
  projectPath?: string
  summary: string
  recentMessages: NormalizedMessage[]
  workspaceState?: {
    gitRemote?: string
    branch?: string
    baseCommit?: string
    diffPatch?: string
    includeUntracked?: boolean
  }
}
```

5. Backend sends `runtime.sessions.create` to the target executor with the fork
   package.
6. Target executor prepares the target directory/worktree, applies requested
   workspace state when possible, and creates a new native runtime session.
7. Backend ensures the source session has an origin SessionBranch. If the fork
   started from an unmatched session, Backend creates the selected WorkItem and
   origin branch first.
8. Backend creates a fork SessionBranch with `parent_branch_id` pointing to the
   source branch.
9. Wework opens the new branch.

## Error Handling

- Device offline: disable open/send/fork for sessions on that device.
- Session missing: show a missing-session state and refresh runtime sessions.
- Transcript parse failure: show a partial transcript if possible and record the
  parse error in the UI.
- Runtime send failure: keep the current session open and display the runtime
  error without creating a failed Subtask.
- Fork target unavailable: keep the source branch active and let the user pick a
  different target.
- ProjectLocation path missing on target: prompt for another path or create the
  directory through an explicit device action.

## Security

- The browser never sends shell commands.
- Backend dispatches only typed runtime RPC over an authenticated device
  WebSocket.
- Runtime RPC validates `runtime`, `session_id`, and path inputs.
- Transcript responses should be size-limited and paginated for large sessions.
- Fork packages should cap recent message count and diff size.
- Backend must verify device ownership for every runtime RPC.

## Testing

- Backend tests cover ProjectLocation matching by device/runtime/path.
- Backend tests cover WorkItem and SessionBranch creation for attach.
- Backend tests cover fork SessionBranch lineage.
- Backend tests cover runtime RPC dispatch only to online owned devices.
- Executor tests cover Codex session listing through the unified RuntimeSession
  schema.
- Executor tests cover Claude Code session listing from local session metadata.
- Executor tests cover transcript normalization for Codex and Claude Code JSONL.
- Wework tests cover Project -> WorkItem -> SessionBranch sidebar rendering.
- Wework tests cover Local Sessions fallback for unmatched sessions.
- Wework tests cover opening a runtime transcript without calling task detail.
- Wework tests cover disabled actions for offline devices.

## POC Sequence

1. Add runtime session RPC over the existing device WebSocket.
2. Implement Codex RuntimeSession list/transcript/send through the new RPC.
3. Implement Claude Code RuntimeSession list/transcript/send through the same
   RPC.
4. Add DB tables for ProjectLocation, WorkItem, and SessionBranch.
5. Add Backend aggregation APIs for project-first runtime workbench data.
6. Update Wework sidebar and open-session state to use runtime sessions.
7. Add attach-to-project.
8. Add fork-to-remote.
