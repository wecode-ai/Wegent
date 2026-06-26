---
sidebar_position: 32
---

# Local-First Cloud Connection

Wework remains a complete local app by default. Local Codex, the local executor, local workspaces, and local conversations do not require Backend login or cloud devices. Cloud connection is an optional capability layer: after the user enters a Backend URL from the sidebar and signs in with the WeWork login flow, server models, cloud devices, and cloud Codex auth sync join the same workbench.

## State Ownership

Cloud connection state is owned by the frontend `cloud-connection` layer and is stored separately from the global `auth_token` used by the web login flow. It persists:

- The Backend root URL entered by the user.
- Normalized `apiBaseUrl`, `socketBaseUrl`, and `socketPath`.
- Cloud login token, expiry, cloud user, and connection time.
- Current status: disconnected, connecting, connected, expired, or error.

Users may enter either the Backend root URL or an `/api` URL. The frontend normalizes that input into HTTP API and Socket.IO connection settings. Connecting first checks `/health`, then reuses the WeWork login form against `/auth/login`; when admin password initialization is required, it reuses the same admin setup form.

## Interaction Entry

The desktop sidebar shows the cloud entry near the bottom:

- Disconnected state shows "local mode / connect cloud".
- Connected state shows the cloud host, cloud user, and online cloud device count.
- Expired or error state asks the user to sign in again while local features remain available.

Settings are grouped by capability:

- Default features: local Codex, local executor, local workspaces, and local conversations.
- After connecting cloud: server models, cloud devices, cloud Codex `auth.json` sync, proxy, and remote device management.

Cloud devices, proxy configuration, and cloud Codex auth sync must use the cloud connection. When disconnected, pages show a connection entry or disabled state and do not write local state to the server.

## Service Merge

Workbench services have three layers:

1. `createLocalAppServices()` provides local IPC, the local device, local runtime work, and local Codex models.
2. `createBackendWorkbenchServices()` wraps Backend HTTP, Socket.IO, models, devices, and runtime work APIs.
3. `createHybridWorkbenchServices()` merges local and cloud services when cloud is connected.

When disconnected, Wework continues to use local services only. When connected, models, devices, and runtime work lists are merged; execution and stream subscriptions route to local IPC or Backend relay by device or source.

## Model Naming

The frontend merge layer must avoid name collisions between local Codex and cloud-synced Codex models. The UI uses unique names:

```text
local:runtime:codex-gpt-5.5
cloud:runtime:codex-gpt-5.5
```

Before execution, `weworkExecution` metadata on the selected model maps the UI name back to the original `modelName` and `modelType`. The backend still receives `codex-gpt-5.5` and `runtime`, so existing Codex model parsing is preserved.

## Local Auth Status

Local Codex `auth.json` status is read through the executor's read-only `runtime_auth_status` command. The command only returns:

- Whether the file exists.
- Target path.
- Updated time.
- File size.
- SHA-256 digest.

It never returns plaintext contents. Wework also does not upload the local auth file by default. Auth contents enter encrypted server storage and device sync only after the user explicitly uploads the file or imports it from an online device on the cloud Codex auth page.

## Disconnect

Disconnecting cloud only clears cloud connection storage. It does not affect:

- Local conversations.
- Open local workspaces.
- Local Codex models.
- The local executor.

After disconnecting, cloud devices, server models, proxy, and cloud auth sync return to unavailable or connect-entry states.
