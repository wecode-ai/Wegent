---
sidebar_position: 32
---

# Local-First Cloud Connection

Wework remains a complete local app by default. Local Codex, local model configs, the local executor, local workspaces, and local conversations do not require Backend login or cloud devices. Cloud connection is an optional capability layer: after the user enters a Backend URL from the sidebar and signs in with the WeWork login flow, server models, cloud devices, and cloud Codex auth sync join the same workbench.

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

- Default features: local Codex, local model configs, local executor, local workspaces, and local conversations.
- After connecting cloud: server models, cloud devices, cloud Codex `auth.json` sync, proxy, and remote device management.

"Models" is the shared entry for local models and Codex `auth.json`. Local model configs are always available; cloud Codex auth sync, upload, import, and proxy switches must use the cloud connection. When disconnected, the page only shows local auth status and cloud feature guidance and does not write local state to the server.

## Service Merge

Workbench services have three layers:

1. `createLocalAppServices()` provides local IPC, the local device, local runtime work, local Codex models, and user-configured local models.
2. `createBackendWorkbenchServices()` wraps Backend HTTP, Socket.IO, models, devices, and runtime work APIs.
3. `createHybridWorkbenchServices()` merges local and cloud services when cloud is connected.

When disconnected, Wework continues to use local services only. When connected, models, devices, and runtime work lists are merged; execution and stream subscriptions route to local IPC or Backend relay by device or source.

## Local Executor Lifecycle

Packaged release builds of Wework must keep one active app paired with one local executor. On release startup, only one Wework instance may stay active; repeated launches focus the existing window. Before starting the local executor for the first time, the app cleans up stale `wegent-executor` processes that use the release fixed `WEGENT_EXECUTOR_APP_IPC_SOCKET` and removes the stale socket, then starts the executor owned by the current app. This prevents a new app from attaching to an executor left by an older app instance.

Debug builds do not enable this single-instance or cleanup policy. Local development may run multiple Wework debug instances at the same time, each with its own `app-runtime/wework-.../app-ipc.sock` socket. Release cleanup must also inspect each candidate executor process environment and terminate only executors using the release fixed socket, so it does not kill executors owned by debug instances.

## Model Naming

The frontend merge layer must avoid name collisions between local Codex, user-configured local models, and cloud-synced Codex models. The UI uses unique names:

```text
local:runtime:codex-gpt-5.5
local:runtime:local-model:<config-id>
cloud:runtime:codex-gpt-5.5
```

Before execution, `weworkExecution` metadata on the selected model maps the UI name back to the original `modelName` and `modelType`. The local IPC execution boundary then normalizes local Codex UI model names to the real model id accepted by Codex app-server; for example, `codex-gpt-5.5` is converted to `gpt-5.5` before sending. User-configured local models use `local-model:<config-id>` and can only be sent to a local device; if the target is a cloud task, the frontend blocks sending and asks the user to switch device or model. Cloud relay paths continue to pass the original execution model name for their source.

The local Codex model catalog follows only the active provider in the current Codex configuration. executor reads `config/read` once through Codex app-server to get the active `model_provider` and display name, then calls `model/list` once for that provider's catalog. Even when `config.toml` contains multiple `[model_providers.*]` entries, Wework does not enumerate them as parallel model groups because Codex `model/list` does not expose a stable provider-scoped query protocol. Use the local model config flow below when Wework needs to show multiple model interfaces.

## Local Model Configs

Local model configs are stored in local browser storage. They are not written to Backend and are not cloud-synced. Each config includes:

- Display name.
- Model ID.
- OpenAI Responses-compatible model URL.
- Optional API Key.
- Enabled state and update time.

When API Key is blank, local runtime sends a `dummy` bearer token to the Codex provider config so no-auth local OpenAI-compatible services can run. Local model configs and the built-in local Codex model enter the existing model selector as `UnifiedModel(type: "runtime")`.

## Proxy Configuration Boundaries

The Proxy page manages local device proxy and cloud device proxy separately. These settings do not reuse each other:

- Local device proxy is stored in Wework local browser storage and only affects new Codex tasks created by the current Wework App through the local executor. It is not written to Backend, is not synced to cloud devices, and does not modify system proxy or user shell environment.
- Cloud device proxy is stored in cloud account configuration and only affects Codex tasks on cloud executors. Local devices do not use that URL.

Saving a local device proxy does not immediately interrupt running Codex tasks. The UI asks the user to restart Codex manually. After confirmation, Wework restarts only the persistent Codex app-server maintained by the current App's local executor; it does not terminate other Codex processes on the machine. The new Codex app-server receives proxy-related environment variables, and later new chats use that proxy.

Codex Responses-compatible models may be routed through the executor's built-in `codex responses proxy` before reaching the upstream model service. That proxy must also use the same local device proxy; otherwise model requests would bypass the Codex app-server process environment. Logs record only whether a proxy is configured and do not print the proxy URL.

## Local Auth Status

Local Codex `auth.json` status is read through the executor's read-only `runtime_auth_status` command. The command only returns:

- Whether the file exists.
- Target path.
- Updated time.
- File size.
- SHA-256 digest.

It never returns plaintext contents. Wework also does not upload the local auth file by default. Auth contents enter encrypted server storage and device sync only after the user explicitly uploads the file or imports it from an online device on the cloud-connected "Model Settings" page.

Wework's remaining-usage display also follows the local Codex account. The frontend first reads the local `auth.json` status; if no Codex account exists, the menu and tray show none. When a local account exists, the frontend reads the Codex app-server `account/rateLimits/read` snapshot through the local executor command `runtime.codex.rate_limits.read` and displays the remaining percentages for the 5-hour and 7-day windows. The desktop system tray refreshes these two values every 60 seconds, shows only usage percentages, does not upload auth contents, and does not substitute Backend Claude quota.

## Disconnect

Disconnecting cloud only clears cloud connection storage. It does not affect:

- Local conversations.
- Open local workspaces.
- Local Codex models.
- Local model configs.
- The local executor.

After disconnecting, cloud devices, server models, proxy, and cloud auth sync return to unavailable or connect-entry states.
