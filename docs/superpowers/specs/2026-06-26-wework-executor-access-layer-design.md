---
sidebar_position: 1
---

# WeWork Executor Access Layer

## Context

WeWork has moved part of its coding workflow toward local-first execution. In
the desktop app, local runtime work can already reach the executor through Tauri
IPC and the executor app IPC path. In the web browser, the same product surface
still reaches executors through Backend HTTP and WebSocket relay.

The current frontend boundary is still shaped around Backend APIs. Workbench
services expose `projectApi`, `deviceApi`, `runtimeWorkApi`, and `taskApi`, and
some workspace components create HTTP clients directly. That makes executor
operations depend on Backend-specific API shapes even when the operation is
really executor-owned: runtime task listing, transcript loading, message
sending, file browsing, device commands, and file-change review.

The desired model is simpler: executor-related logic should not care whether an
executor is local or remote. Local IPC, Backend relay, and future direct remote
RPC are transport choices. Backend remains important for web access, remote
device discovery, and authorization, but it should not be the business-layer
owner of executor capabilities.

## Goals

- Introduce a single executor access layer for WeWork workbench execution paths.
- Keep a process-local in-memory registry of currently accessible executors.
- Let Mac app local executor operations work without Backend.
- Keep web browser access working through Backend discovery and Backend relay.
- Let Mac app remote executor operations continue through Backend relay in the
  first phase.
- Remove direct Backend HTTP client creation from workbench core executor
  paths.
- Make executor capabilities explicit: runtime work, device commands, workspace
  files, and file-change review.
- Keep non-executor product APIs, such as account settings and plugin
  management, outside the first phase unless they are needed by the workbench
  execution path.

## Non-Goals

- Do not implement direct browser-to-remote-executor RPC in this phase.
- Do not persist the executor registry to local storage or disk.
- Do not remove Backend as the web transport for remote executors.
- Do not migrate every settings or plugin page in this phase.
- Do not keep legacy `TaskResource` or `Subtask` diff paths as a fallback for
  local runtime review.
- Do not change executor runtime ownership: LocalTask state remains on the
  executor device.

## Architecture

Add an executor access layer made of three small units:

1. `ExecutorRegistry`
   Holds the currently available executors in memory. Each entry includes
   `deviceId`, display name, status, version, capabilities, transport kind, and
   the authorization context needed by its transport. The registry is rebuilt on
   startup, explicit refresh, device status updates, and authentication changes.

2. `ExecutorClient`
   Provides capability-oriented methods to workbench code:

   ```ts
   executorClient.runtime.list()
   executorClient.runtime.transcript(address)
   executorClient.runtime.search(request)
   executorClient.runtime.send(request)
   executorClient.runtime.cancel(address)
   executorClient.runtime.archive(address)
   executorClient.runtime.rename(request)
   executorClient.commands.execute(deviceId, command)
   executorClient.files.list(deviceId, path)
   executorClient.files.read(deviceId, filePath)
   executorClient.review.load(address, fileChanges)
   executorClient.review.revert(address, fileChanges)
   ```

   The client resolves the target executor from the registry for each call and
   delegates to the matching transport.

3. `ExecutorTransport`
   Encapsulates how a request reaches an executor. The first phase needs two
   implementations:

   - `LocalIpcExecutorTransport` for Mac app local executor access through Tauri
     and executor app IPC.
   - `BackendRelayExecutorTransport` for web browser access and Mac app remote
     executor access through Backend relay.

Workbench components depend on `ExecutorClient`, not on Backend HTTP APIs or
Tauri APIs directly.

## Runtime Modes

### Mac App

The Mac app initializes the registry from two sources:

1. Local source:
   Start or verify the local executor through Tauri, then add it to the
   registry with `transportKind: 'local-ipc'`.

2. Backend source:
   If the user has a valid Backend session, fetch accessible remote executors and
   authorization context, then add them with `transportKind: 'backend-relay'`.

If Backend is unavailable, the local executor remains available and the
workbench core path continues to run.

### Web Browser

The web browser has no Tauri IPC source. It initializes the registry from
Backend discovery only. Every executor entry uses
`transportKind: 'backend-relay'`.

If Backend is unavailable in the browser, the registry fails to load and the UI
shows a single executor-access error instead of letting individual panels fail
with unrelated Backend API errors.

## Workbench Migration Scope

The first phase migrates only the workbench core executor paths:

- Runtime work:
  list, transcript, search, create, send, cancel, fork, archive, unarchive,
  rename, and delete.
- Workspace lifecycle:
  prepare, open, rename, remove, and delete device workspaces.
- Device commands:
  execute command, home directory, project workspace root, directory listing,
  directory creation, and skill listing.
- Workspace files:
  file tree listing and text file reading.
- File-change review:
  load runtime file-change diff and revert runtime file changes.

The following areas remain outside the first migration phase unless a workbench
core path calls them:

- Plugin marketplace and MCP management.
- Account and quota settings.
- Cloud device provisioning and upgrade management.
- Runtime credential and proxy settings.
- IM notification binding.

Those pages may still use Backend APIs directly until they are migrated to the
same executor access layer or a separate cloud-management service boundary.

## Current Code Changes Implied By The Design

- `WorkbenchServices` should stop treating executor operations as Backend API
  facades. It should expose an executor-oriented service or an `ExecutorClient`
  instance for workbench execution paths.
- `FileWorkspacePanel` must not create its own `createHttpClient`. It should use
  the workbench executor file capability so Mac app local file browsing reaches
  the local executor through IPC and web browsing reaches Backend relay.
- Workspace panel actions that open terminal, IDE, browser, or code-server
  sessions should route executor-backed operations through `ExecutorClient`.
  Purely local Tauri terminal launch can remain a Tauri-specific implementation
  behind a workbench tool service.
- `createLocalAppServices` should no longer mimic a partial Backend service
  bundle. It should become a local registry source plus local IPC transport.
- Legacy `taskApi.getTurnFileChangesDiff` and
  `taskApi.revertTurnFileChanges` should not be used as local runtime fallbacks.
  If a runtime file-change artifact cannot be resolved, the UI should show a
  runtime review error from the executor access layer.

## Data Flow

### Runtime List

1. Workbench calls `executorClient.runtime.list()`.
2. The client asks the registry for all executors with `runtime-work` capability.
3. Local executors are queried through `LocalIpcExecutorTransport`.
4. Remote executors are queried through `BackendRelayExecutorTransport`.
5. Results are normalized into the existing runtime work response shape for the
   workbench reducer.

### Open Transcript

1. The route supplies `deviceId + localTaskId`.
2. The client resolves `deviceId` in the registry.
3. The selected transport sends `runtime.tasks.transcript`.
4. The workbench renders normalized messages.

### Workspace Files

1. The file panel calls `executorClient.files.list(deviceId, path)`.
2. The selected transport sends a workspace tree command to the executor.
3. The file panel calls `executorClient.files.read(deviceId, filePath)` for
   preview.
4. Text rendering, syntax highlighting, and scroll behavior stay in the UI
   layer; file access stays in the executor access layer.

### File-Change Review

1. The review UI passes the current runtime address and file-change artifact.
2. The client calls the executor runtime review command for that artifact.
3. The executor returns a normalized diff or an artifact-specific error.
4. Revert uses the same runtime address and artifact identity.

## Error Handling

Executor access errors should be normalized before they reach components:

- `executor-not-found`: registry does not contain the target `deviceId`.
- `executor-unavailable`: target exists but is offline or unreachable.
- `capability-unavailable`: target does not support the requested capability.
- `authorization-required`: Backend relay transport lacks valid authorization.
- `command-failed`: executor returned a failed command or runtime response.
- `artifact-missing`: runtime file-change artifact is no longer available.

Components should render these errors as executor/workspace state, not as raw
Backend HTTP failures. The same error type should behave consistently in Mac app
and web browser.

## Authorization

The registry stores only the minimum authorization context required by each
transport:

- Local IPC transport uses the app-managed local executor channel and does not
  need a Backend token.
- Backend relay transport uses the current Backend session and per-device access
  rules enforced by Backend.

The first phase does not expose relay tokens directly to browser JavaScript for
direct remote RPC. If future direct remote transport is added, it must use
short-lived scoped credentials and be introduced as a new transport
implementation without changing workbench business components.

## Testing

Unit tests should cover:

- Registry initialization for Mac app with local executor only.
- Registry initialization for Mac app with local plus remote executors.
- Registry initialization for web browser with Backend relay executors only.
- Resolution failures for unknown `deviceId`.
- Transport selection for local IPC versus Backend relay.
- File tree and file read calls using `ExecutorClient` rather than direct HTTP
  clients.
- Runtime transcript/send/search/list calls through the executor access layer.
- File-change review failures for missing artifacts without falling back to
  legacy task APIs.

Integration-style tests should verify:

- Mac app local-first workbench can list runtime work, open a transcript, browse
  files, and load review diff without Backend.
- Web workbench can perform the same actions through Backend relay.
- Existing settings and plugin pages continue to work through Backend where they
  remain intentionally out of scope.

## Rollout Plan

1. Add executor access types, registry, and transport interfaces.
2. Implement local IPC transport by adapting the existing local executor calls.
3. Implement Backend relay transport by adapting existing Backend APIs.
4. Build a workbench executor service from the registry and client.
5. Migrate runtime work operations in `WorkbenchProvider`.
6. Migrate file tree and file preview panels.
7. Migrate runtime file-change review and revert.
8. Migrate workspace panel executor-backed actions.
9. Remove direct HTTP client creation from migrated workbench core paths.
10. Add tests for both Mac app and web browser runtime modes.

## Open Decisions

- Exact module names can be chosen during implementation, but the access layer
  should live outside individual UI panels.
- Settings pages should be migrated later only when their behavior is redefined
  as executor management rather than cloud account management.
- Direct remote executor transport remains a future extension, not part of this
  phase.
