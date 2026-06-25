---
sidebar_position: 1
---

# WeWork Local-First App Runtime

## Context

WeWork is currently a Tauri/Vite React app that assumes a Backend API is
available. `AuthProvider` requires Backend authentication before rendering the
workbench, and `WorkbenchProvider` creates API services from
`getRuntimeConfig().apiBaseUrl`. Runtime LocalTask work is already device-owned:
Backend lists local work by fanning out `runtime:rpc` calls to online local
executors, and executor-local state remains on the user's device.

The product direction is stronger than standalone Docker mode: packaged WeWork
should behave like a real local desktop app. Its main coding workflow must run
without Backend, and the local app must not start an additional local gateway,
HTTP service, FastAPI service, or Socket.IO server. The local runtime consists
of the WeWork desktop app UI and one executor process managed by the app.

Backend remains useful after an optional login for cloud capabilities such as
model synchronization, cloud projects, remote devices, and web control of the
user's local computer. The existing Wegent frontend must not change. Web users
should continue to reach local computers through Backend and the existing local
executor WebSocket channel.

## Goals

- Let packaged desktop WeWork open and run local tasks without Backend.
- Keep the local runtime to two processes: the WeWork app and an executor child
  or managed sidecar.
- Make the local app path the primary WeWork runtime path, not a fallback after a
  failed Backend request.
- Keep Backend connection optional for login, model synchronization, cloud
  project operations, remote/cloud devices, and web control of local devices.
- Let one executor connect directly to the WeWork app and also connect to
  Backend at the same time.
- Preserve the existing Backend-controlled path for the Wegent frontend.
- Reuse the existing executor runtime-work RPC and device command semantics
  wherever possible.
- Keep local task state on the device and avoid creating central `TaskResource`
  or `Subtask` rows for local runtime work.
- Make the first implementation independently verifiable without a running
  Backend.

## Non-Goals

- Do not change the Wegent frontend.
- Do not require users to run the full Backend stack for local WeWork tasks.
- Do not start a local app gateway, local HTTP API, FastAPI helper, or app-owned
  Socket.IO server for the desktop local path.
- Do not embed MySQL, Redis, or the Backend service inside the desktop app.
- Do not make Backend the owner of local runtime task state.
- Do not implement full cloud model/project sync in the first local execution
  pass; design the seam so sync can be added without changing local execution.
- Do not expose a public executor API from the user's machine.
- Do not expose raw shell execution to the renderer.
- Do not remove the current Backend device WebSocket protocol.

## Recommended Architecture

Packaged WeWork owns a direct local control plane. Tauri supervises an executor
sidecar or managed child process and talks to it over newline-delimited JSON-RPC
on stdin/stdout. React does not manage processes directly. The renderer uses
local service adapters that call Tauri commands and listen for Tauri events.

```mermaid
flowchart LR
    subgraph "User Desktop"
        UI["WeWork React UI"]
        TAURI["Tauri Rust Shell"]
        IPC["stdin/stdout JSON-RPC"]
        EX["Wegent Executor"]
        RT["Codex / Claude Code"]
        FS["Local Files"]
    end

    subgraph "Optional Cloud"
        BE["Wegent Backend"]
        WEB["Wegent Frontend"]
    end

    UI -->|"Tauri invoke + events"| TAURI
    TAURI <-->|"child process stdio"| IPC
    IPC <-->|"newline JSON messages"| EX
    EX --> RT
    RT --> FS

    UI -. optional login/sync .-> BE
    EX -. optional Socket.IO backend channel .-> BE
    WEB -. existing Backend path .-> BE
    BE -. existing /local-executor routing .-> EX
```

Tauri remains responsible for process ownership:

- locate the bundled or managed executor binary
- start the executor with local app IPC enabled
- pass optional Backend channel settings to the executor when cloud/web control
  is configured
- parse executor stdout lines into JSON responses and events
- write JSON requests to executor stdin
- expose request commands and event subscriptions to React
- restart or reconnect the child process only after explicit local runtime retry
- surface executor startup errors in WeWork settings and workbench state

The executor remains responsible for runtime work, device commands, tool
execution, and optional Backend registration. No additional local process sits
between the app and executor.

## Runtime Modes

### Local-First Mode

Local-first mode is the default for packaged desktop WeWork.

- `AuthProvider` creates a local user/session and does not redirect to
  `/login`.
- `WorkbenchProvider` receives local services through the existing `services`
  injection boundary.
- Runtime tasks, device commands, model defaults, skills, and workspace
  metadata come from local service adapters backed by Tauri executor IPC.
- Backend being unavailable does not block workbench bootstrap or task send.

### Cloud-Connected Mode

Cloud-connected mode is an optional capability layered on top of local-first
mode.

- A user can sign in to Backend from settings or login UI.
- Backend services can synchronize model definitions, cloud projects, remote
  device metadata, and other account-scoped data into local app state.
- Local task execution still routes through direct app-to-executor IPC unless
  the user explicitly selects a cloud/remote device.
- If Backend disconnects, local tasks continue and sync status degrades to
  offline.

### Web-Control Mode

Web-control mode is the existing Backend path used by the Wegent frontend.

- The executor keeps an optional Backend Socket.IO channel.
- Backend still owns web auth, device online state, command RPC, and
  runtime-work fan-out for web users.
- No Wegent frontend change is required.

## Direct App IPC Protocol

The app-to-executor protocol is newline-delimited JSON over the executor
process's stdin/stdout. Each line is one complete JSON object encoded as UTF-8.
The protocol has three message classes.

### Request

```json
{
  "type": "request",
  "id": "local-req-0001",
  "method": "runtime.tasks.create",
  "params": {
    "device_id": "local-device",
    "runtime_family": "codex",
    "message": "Implement the selected change",
    "workspace": {
      "path": "/Users/example/project"
    }
  }
}
```

### Response

```json
{
  "type": "response",
  "id": "local-req-0001",
  "ok": true,
  "result": {
    "task": {
      "deviceId": "local-device",
      "localTaskId": "task_123"
    }
  }
}
```

Errors use the same envelope and include a stable code and human-readable
message:

```json
{
  "type": "response",
  "id": "local-req-0001",
  "ok": false,
  "error": {
    "code": "executor_not_ready",
    "message": "The local executor is still starting."
  }
}
```

### Event

```json
{
  "type": "event",
  "event": "response.output_text.delta",
  "payload": {
    "deviceId": "local-device",
    "localTaskId": "task_123",
    "delta": "Done"
  }
}
```

The Tauri bridge keeps an in-memory map from request id to pending request,
enforces request timeouts, and emits executor events to the renderer as
`local-executor:event`. Requests that outlive the child process fail with
`executor_disconnected`.

## Local Service Responsibilities

The local service layer provides the minimal Backend-like surface that WeWork
needs for local coding workflows. These services live in the WeWork frontend and
call Tauri commands rather than Backend HTTP APIs.

### Local Session

Local-first mode returns a local user:

```json
{
  "id": 0,
  "user_name": "local",
  "email": "local@wework.local",
  "preferences": {}
}
```

The local session is not a Backend account. Cloud login stores separate cloud
credentials and sync metadata.

### Default Team

Local-first mode returns one local default Team for workbench execution:

```json
{
  "id": 0,
  "name": "local-wework",
  "displayName": "Local WeWork",
  "is_active": true,
  "default_for_modes": ["wework"],
  "recommended_mode": "code"
}
```

The executor does not need a central Team row for runtime LocalTasks; the Team
object only satisfies WeWork's UI and send payload contract.

### Models

The local service returns model definitions from local runtime configuration,
Codex config, Claude Code config, and optional cloud sync cache. Local models
must be enough for `useWorkbenchModels` to infer the runtime family and build a
`RuntimeTaskCreateRequest`.

Cloud-synced models can be merged into the local list, but local execution must
not depend on a successful sync.

### Devices

The Tauri bridge reports the managed executor as an online `local` device when
the child process is running and has completed IPC initialization. The device
shape should match the current WeWork expectations, including:

- `device_id`
- `name`
- `status`
- `device_type`
- `bind_shell`
- `executor_version`
- `capabilities`
- `slot_used`
- `slot_max`
- `runtime_transfer_host`

### Runtime Work

The local runtime-work service exposes the same API shape used by
`WorkbenchProvider`:

- list runtime work
- search local work
- open transcript
- create task
- send message
- cancel task
- archive, unarchive, rename, and delete archived conversations
- open, rename, and remove runtime workspaces
- fork runtime tasks where both source and target devices are available

The service calls the executor through the same method names currently used by
Backend's `runtime:rpc` path:

- `runtime.tasks.list`
- `runtime.tasks.search`
- `runtime.tasks.transcript`
- `runtime.tasks.create`
- `runtime.tasks.send`
- `runtime.tasks.cancel`
- `runtime.workspaces.open`
- `runtime.workspaces.rename`
- `runtime.workspaces.remove`

The response shapes stay compatible with `wework/src/types/api.ts`.

### Device Commands

The local device service exposes the same high-level command operations used by
WeWork today. It resolves command keys through a registry equivalent to
Backend's `DEFAULT_LOCAL_DEVICE_COMMANDS` and sends `device.execute_command` to
the executor over app IPC. The renderer never sends raw shell commands.

### Streaming

Runtime Responses events emitted by the executor are forwarded to the WeWork
renderer over the same logical event names currently handled by the workbench
stream layer:

- `response.created`
- `response.in_progress`
- `response.output_text.delta`
- `response.completed`
- `response.incomplete`
- `error`

The local stream client subscribes to Tauri's `local-executor:event`, filters by
`deviceId + localTaskId`, and feeds existing chat stream reducers. Backend
Socket.IO remains in use only for Backend mode and web-control mode.

## Executor Direct-App Mode

The executor should separate runtime logic from connection ownership. It gains a
direct app IPC channel in addition to its existing Backend WebSocket channel.

```json
{
  "app_ipc": {
    "enabled": true,
    "transport": "stdio",
    "device_id": "local-device"
  },
  "channels": [
    {
      "name": "backend",
      "url": "https://backend.example.com",
      "auth_token": "wg-...",
      "enabled": true
    }
  ]
}
```

For compatibility, existing `connection.backend_url` and
`connection.auth_token` remain supported and map to a single `backend` channel.

Direct app IPC and Backend channel each have independent:

- registration or readiness state
- heartbeat or liveness reporting
- runtime RPC request handling
- command RPC request handling
- streaming event emitter
- reconnect policy for Backend only

The same runtime task can be created through the app channel or Backend channel,
but an individual request is owned by the channel that dispatched it. Streaming
events return to the same channel to avoid duplicate UI updates. Native Codex
watcher notifications should include the channel context that caused the send
when possible; passive native updates can be broadcast to connected channels
only after terminal messages are deduplicated by `deviceId + localTaskId`.

## WeWork Service Boundary

WeWork should keep `WorkbenchProvider` as the main UI state owner. The service
boundary becomes explicit:

```text
createDefaultServices()
  packaged local-first app -> createLocalAppServices()
  browser/dev/backend mode -> createBackendServices()
```

`createLocalAppServices()` provides the same service contracts used by
`WorkbenchProvider`:

- `teamApi`
- `modelApi`
- `skillApi`
- `deviceApi`
- `runtimeWorkApi`
- `userApi`
- `socketClient`
- `chatStream`

APIs that are cloud-only should return a clear "cloud connection required"
error in local-first mode instead of trying to contact Backend implicitly.

The runtime config should distinguish app runtime mode from API URL:

```ts
type RuntimeMode = 'local-first' | 'backend'
```

Packaged Tauri defaults to `local-first`. Browser dev mode can keep the current
Backend default.

## Cloud Sync Boundary

Cloud sync is an optional layer with explicit state:

- disconnected
- signing in
- connected
- syncing
- sync failed

Cloud data should be cached locally and merged into local services only after a
successful sync. Local models and local tasks remain usable if cloud sync is not
configured or fails.

Cloud project operations must not mutate local runtime task identity. LocalTask
identity remains `deviceId + localTaskId`; workspace path remains context for
tools and grouping.

## Process And Packaging

Desktop packages should include enough local runtime components to run without
Backend:

- WeWork frontend assets
- Tauri native shell
- bundled executor sidecar or managed executor binary
- optional reuse of a compatible managed installed executor

On startup:

1. Tauri creates the local executor supervisor state.
2. Tauri starts or locates the executor with app IPC enabled.
3. Tauri passes optional Backend channel settings to the executor when the user
   has configured cloud/web control.
4. React receives local runtime mode and local executor readiness through
   runtime config and Tauri commands.
5. WeWork bootstraps from local services.

If the executor cannot start, WeWork should still open and show a connection
state that lets the user retry setup. It should not redirect to Backend login.

## Security

- App-to-executor communication stays inside the parent/child process boundary.
- The executor process is launched only from a configured bundled binary or a
  verified managed executor path.
- Device commands remain key-based and registry-controlled.
- Raw shell command execution is not exposed to the renderer.
- Cloud credentials are stored separately from local session state.
- Logs must redact cloud tokens and any generated process credentials.
- Renderer access to local IPC is limited to explicit Tauri commands.

## Error Handling

- Backend unavailable: local workbench remains usable; cloud sync shows
  disconnected.
- Executor startup failure: packaged app shows a local runtime startup error
  and retry action.
- Executor disconnected: pending local IPC requests fail with
  `executor_disconnected`, device list shows no online local executor, and
  sending is blocked with a local executor setup message.
- Executor connected to Backend but not app IPC: web control still works; app
  local work remains unavailable until the app IPC channel is ready.
- App IPC connected but Backend disconnected: local tasks continue; web control
  and cloud sync are unavailable.
- Same executor connected to both paths: each path reports independent online
  state and routes only its own requests.

## First Implementation Scope

The first implementation should produce working software that proves the local
main path:

- Packaged desktop WeWork opens without Backend.
- WeWork renders the workbench with a local user and local default Team.
- The app starts or discovers a local executor.
- The executor initializes direct app IPC over stdio.
- WeWork lists local runtime work through Tauri-backed local services.
- WeWork can create a new local runtime task without Backend.
- WeWork can continue an existing local runtime task without Backend.
- Runtime Responses events stream back to the current WeWork window.
- Basic device commands used by workspace, git, diff, and file views work
  through direct app IPC.
- Existing Backend path remains available for the Wegent frontend and for
  optional executor Backend channel registration.

Cloud login, cloud model sync, and cloud project operations should be present as
clear extension points or settings surface, but they are not required for local
task execution to pass.

## Testing

Unit tests:

- Runtime config selects `local-first` for packaged Tauri and Backend mode for
  browser/dev defaults.
- AuthProvider creates a local user in local-first mode without calling Backend.
- Workbench default services select local services in local-first mode.
- Local service adapters return the expected user, Team, model, device, and
  runtime-work shapes.
- Tauri local executor IPC bridge correlates responses by request id and emits
  executor events to the renderer.
- Executor channel config maps legacy `connection` to a `backend` channel.
- Executor can run direct app IPC and optional Backend channel independently.

Integration tests:

- Executor app IPC accepts `runtime.tasks.list` and returns the runtime-work
  response shape.
- Executor app IPC accepts `runtime.tasks.create` and emits streaming response
  events for the created task.
- Executor app IPC accepts `device.execute_command` through the command
  registry.
- Tauri local services can bootstrap Workbench with Backend stopped.

Manual verification:

- Start packaged WeWork with Backend stopped.
- Verify the workbench opens without redirecting to `/login`.
- Verify a local executor appears online.
- Send a new local task and observe streaming assistant output.
- Refresh the app and reopen the LocalTask transcript.
- Start Backend separately, connect the executor Backend channel, and verify
  web control still works without changing the Wegent frontend.

## Documentation Updates

After implementation, update Chinese docs first, then English:

- `docs/zh/developer-guide/wework-local-first-app.md`
- `docs/en/developer-guide/wework-local-first-app.md`
- `docs/zh/developer-guide/local-device-architecture.md`
- `docs/en/developer-guide/local-device-architecture.md`
- `executor/docs/LOCAL_MODE.md`

The docs must explain that local WeWork task execution does not require Backend,
while Backend login adds optional cloud capabilities.
