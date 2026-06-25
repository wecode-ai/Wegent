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

The new product direction is stronger than the existing standalone Docker mode:
packaged WeWork should be a real local desktop app. Its main coding workflow
must not depend on Backend being started. Backend remains useful after an
optional login for cloud capabilities such as model synchronization, cloud
projects, remote devices, and web control of the user's local computer.

The existing Wegent frontend must not change. Web users should continue to reach
local computers through Backend and the existing local executor WebSocket
channel.

## Goals

- Let packaged desktop WeWork open and run local tasks without Backend.
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
- Do not embed MySQL, Redis, or the Backend service inside the desktop app.
- Do not make Backend the owner of local runtime task state.
- Do not implement full cloud model/project sync in the first local execution
  pass; design the seam so sync can be added without changing local execution.
- Do not expose a public executor HTTP API from the user's machine. App and
  executor communication stays on loopback.
- Do not remove the current Backend device WebSocket protocol.

## Recommended Architecture

Packaged WeWork owns a local control plane. The control plane is a small
loopback service started and supervised by the Tauri app. It exposes a
Backend-compatible subset of APIs to WeWork and a `/local-executor` Socket.IO
namespace to local executors.

```mermaid
flowchart LR
    subgraph "User Desktop"
        WW["WeWork Tauri App"]
        LG["Local App Gateway"]
        EX["Wegent Executor"]
        RT["Codex / Claude Code"]
        FS["Local Files"]
    end

    subgraph "Optional Cloud"
        BE["Wegent Backend"]
        WEB["Wegent Frontend"]
    end

    WW -->|HTTP + app events on loopback| LG
    EX <-->|Socket.IO /local-executor| LG
    EX --> RT
    RT --> FS

    WW -. optional login/sync .-> BE
    EX -. optional second Socket.IO channel .-> BE
    WEB -. existing Backend path .-> BE
    BE -. existing /local-executor routing .-> EX
```

The local app gateway should be implemented in Python/FastAPI/Socket.IO and
shipped as part of the desktop app's bundled local runtime helper. The helper
can be the executor binary running a gateway mode, or a sibling binary built
from the same executor package. The desktop app must not require a separately
installed helper for the default local path, although it may reuse or upgrade a
compatible installed executor when one already exists. This avoids
reimplementing Socket.IO server behavior in Rust and matches the existing
executor dependencies: the executor package already includes FastAPI, uvicorn,
and python-socketio.

Tauri remains responsible for process ownership:

- choose local gateway port and token
- start or find the local gateway
- start or find the local executor
- pass local connection settings to the React app
- surface gateway or executor startup errors in WeWork settings

## Runtime Modes

### Local-First Mode

Local-first mode is the default for packaged desktop WeWork.

- `AuthProvider` creates a local user/session and does not redirect to
  `/login`.
- `WorkbenchProvider` receives local services through the existing `services`
  injection boundary.
- Runtime tasks, device commands, model defaults, skills, and workspace
  metadata come from the local app gateway.
- Backend being unavailable does not block workbench bootstrap or task send.

### Cloud-Connected Mode

Cloud-connected mode is an optional capability layered on top of local-first
mode.

- A user can sign in to Backend from settings or login UI.
- Backend services can synchronize model definitions, cloud projects, remote
  device metadata, and other account-scoped data into local app state.
- Local task execution still routes through the local gateway unless the user
  explicitly selects a cloud/remote device.
- If Backend disconnects, local tasks continue and sync status degrades to
  offline.

### Web-Control Mode

Web-control mode is the existing Backend path used by the Wegent frontend.

- The executor keeps an optional Backend channel.
- Backend still owns web auth, device online state, command RPC, and
  runtime-work fan-out for web users.
- No Wegent frontend change is required.

## Local App Gateway Responsibilities

The gateway provides the minimal Backend-like surface that WeWork needs for
local coding workflows.

### Local Session

The gateway returns a local user:

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

The gateway returns one local default Team for workbench execution:

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

The gateway returns local model definitions from local runtime configuration,
Codex config, Claude Code config, and optional cloud sync cache. Local models
must be enough for `useWorkbenchModels` to infer the runtime family and build a
`RuntimeTaskCreateRequest`.

Cloud-synced models can be merged into the local list, but local execution must
not depend on a successful sync.

### Devices

The gateway maintains an in-memory and lightweight persisted registry of
executors connected to the app. A local executor connected to the gateway is
reported as an online `local` device. The device shape should match the current
WeWork expectations, including:

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

The gateway exposes the same local runtime work API shape used by WeWork:

- list runtime work
- search local work
- open transcript
- create task
- send message
- cancel task
- archive, unarchive, rename, and delete archived conversations
- open, rename, and remove runtime workspaces
- fork runtime tasks where both source and target devices are available

The gateway should call the target executor through the same
`runtime:rpc` event and method names currently used by Backend:

- `runtime.tasks.list`
- `runtime.tasks.search`
- `runtime.tasks.transcript`
- `runtime.tasks.create`
- `runtime.tasks.send`
- `runtime.tasks.cancel`
- `runtime.workspaces.open`
- `runtime.workspaces.rename`
- `runtime.workspaces.remove`

The response shapes should stay compatible with `wework/src/types/api.ts`.

### Device Commands

The gateway exposes local equivalents of:

```text
POST /devices/{device_id}/commands
```

It resolves command keys through a command registry equivalent to Backend's
`DEFAULT_LOCAL_DEVICE_COMMANDS` and sends `device:execute_command` to the
executor. WeWork should not gain a raw shell execution API.

### Streaming

Runtime Responses events emitted by the executor should be forwarded to the
WeWork renderer over the same logical event names currently handled by the
workbench stream layer:

- `response.created`
- `response.in_progress`
- `response.output_text.delta`
- `response.completed`
- `response.incomplete`
- `error`

The first implementation can keep the existing Socket.IO client abstraction by
providing a local Socket.IO namespace that behaves like the current chat stream
for runtime events.

## Executor Multi-Channel Model

The executor should separate device runtime logic from connection ownership.
Instead of a single implicit Backend connection, it should support named
channels:

```json
{
  "channels": [
    {
      "name": "app",
      "url": "http://127.0.0.1:<local-gateway-port>",
      "auth_token": "<ephemeral-local-token>",
      "enabled": true
    },
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

Each channel has independent:

- WebSocket client
- registration state
- heartbeat loop
- runtime RPC request handling
- command RPC request handling
- streaming event emitter
- reconnect policy

The same runtime task can be created through the app channel or Backend channel,
but an individual request is owned by the channel that dispatched it. Streaming
events should return to the same channel to avoid duplicate UI updates. Native
Codex watcher notifications should also include the channel context that caused
the send when possible; passive native updates can be broadcast to connected
channels only after terminal messages are deduplicated by `deviceId +
localTaskId`.

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
- bundled local app gateway helper
- bundled local executor helper
- optional reuse of a compatible managed installed executor

On startup:

1. Tauri chooses a loopback gateway port and creates an ephemeral token.
2. Tauri starts the local app gateway if it is not already healthy.
3. Tauri starts or locates the local executor.
4. Tauri configures the executor `app` channel with the gateway URL and token.
5. React receives local gateway API/socket config through runtime config.
6. WeWork bootstraps from local services.

If the executor cannot start, WeWork should still open and show a connection
state that lets the user retry setup. It should not redirect to Backend login.

## Security

- The local gateway listens only on loopback.
- The gateway uses a per-launch token generated by Tauri.
- The token is passed to the renderer only through runtime config and to the
  executor through process environment or channel config.
- Device commands remain key-based and registry-controlled.
- Raw shell command execution is not exposed to the renderer.
- Cloud credentials are stored separately from local session state.
- Logs must redact local gateway tokens and cloud tokens.

## Error Handling

- Backend unavailable: local workbench remains usable; cloud sync shows
  disconnected.
- Local gateway unavailable: packaged app shows a local runtime startup error
  and retry action.
- Executor unavailable: workbench opens, device list shows no online local
  executor, and sending is blocked with a local executor setup message.
- Executor connected to Backend but not app: web control still works; app-local
  work remains unavailable until the app channel connects.
- App connected but Backend disconnected: local tasks continue; web control and
  cloud sync are unavailable.
- Same executor connected to both channels: each channel reports independent
  online state and routes only its own requests.

## First Implementation Scope

The first implementation should produce working software that proves the local
main path:

- Packaged desktop WeWork opens without Backend.
- WeWork renders the workbench with a local user and local default Team.
- The app starts or discovers the local gateway.
- The app starts or discovers a local executor.
- The executor registers to the app channel.
- WeWork lists local runtime work through the local gateway.
- WeWork can create a new local runtime task without Backend.
- WeWork can continue an existing local runtime task without Backend.
- Runtime Responses events stream back to the current WeWork window.
- Basic device commands used by workspace, git, diff, and file views work
  through the local gateway.
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
- Executor channel config maps legacy `connection` to a `backend` channel.
- Executor can build independent `app` and `backend` channel clients.

Integration tests:

- Local gateway accepts executor registration and heartbeat.
- Local gateway dispatches `runtime:rpc` to a connected executor and returns the
  response.
- Local gateway dispatches `device:execute_command` through the command registry.
- Runtime Responses events emitted by executor are forwarded to WeWork's local
  stream client.

Manual verification:

- Start packaged WeWork with Backend stopped.
- Verify the workbench opens without redirecting to `/login`.
- Verify a local executor appears online.
- Send a new local task and observe streaming assistant output.
- Refresh the app and reopen the LocalTask transcript.
- Start Backend separately, connect the executor backend channel, and verify
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
