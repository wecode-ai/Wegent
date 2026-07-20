---
sidebar_position: 32
---

# Local-First Cloud Connection

Wework remains a complete local app by default. Local Codex, local model configs, the local executor, local workspaces, and local conversations do not require Backend login or cloud devices. Cloud connection is an optional capability layer: after the user enters a Backend URL from the sidebar and signs in with the WeWork login flow, server models, cloud devices, and cloud Codex auth sync join the same workbench.

Set `VITE_WEGENT_BACKEND_URL` at build time to provide the default Backend URL in Connect cloud. This value only prefills the field and remains editable; an existing local connection address takes precedence over the build default. When configured, the desktop account area shows "Wegent account / Not signed in" while disconnected and continues to open the full account menu. Users start cloud authorization through "Sign in to Wegent" at the top of that menu. After connection, the account area shows the cloud username and email; Log out in the account menu only disconnects the cloud connection.

## State Ownership

Cloud connection state is owned by the frontend `cloud-connection` layer and is stored separately from the global `auth_token` used by the web login flow. It persists:

- The Backend root URL entered by the user.
- Normalized `apiBaseUrl`, `socketBaseUrl`, and `socketPath`.
- Cloud login token, expiry, cloud user, and connection time.
- Current status: disconnected, connecting, connected, expired, or error.

Users may enter either the Backend root URL or an `/api` URL. The frontend normalizes that input into HTTP API and Socket.IO connection settings. Connecting first checks `/health`, then calls `/auth/wework/sessions` to create a short-lived authorization session. Backend returns a complete `authorize_url`; local Wework opens that cloud authorization page in the embedded authorization browser and polls the session result with the client-only `poll_token`.

When the entered address matches the packaged `VITE_WEGENT_BACKEND_URL` or `VITE_API_BASE_URL`, Wework uses the packaged `VITE_SOCKET_BASE_URL` and `VITE_SOCKET_PATH`, allowing the HTTP API and Socket.IO service to use separate domains. This also covers manually entered Backends when `VITE_WEGENT_BACKEND_URL` is unset but the address corresponds to the packaged API. Connections saved with the old same-origin Socket URL are migrated on startup. Other user-entered Backends continue to use same-origin normalization.

Local Wework does not render cloud username/password forms and does not call `/auth/login` or `/auth/admin-password/setup`. Cloud login, OIDC, and admin initialization all happen on the cloud Wegent Web authorization page. After login, the user must explicitly approve Wework access; only then does Backend store a one-time claimable cloud JWT in the authorization session. Local Wework claims it, verifies the user through `/users/me`, and persists the cloud connection state.

Backend builds the authorization page URL from `WEWORK_AUTHORIZE_BASE_URL`; when unset, it falls back to `FRONTEND_URL`. Deployments with separate API and Web origins must configure the Web root URL explicitly. The Wework client only opens the complete `authorize_url` returned by Backend and does not infer the Web address itself.

## Interaction Entry

The desktop sidebar provides two cloud entry points with distinct responsibilities:

- The workspace entry shows cloud connection status. It says "Connect cloud" while disconnected and "Cloud connection expired" after login expiry; clicking it can restore the connection directly.
- The account area always opens the account menu and does not change its click behavior with login state. While signed out, "Sign in to Wegent" appears at the top of the menu, and Settings, Check for updates, and Remaining usage stay accessible.
- After connection, the account area shows the cloud username and email, while the workspace entry shows the cloud host, cloud user, and online cloud device count.
- Expired or failed cloud connections do not block local features.

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

## Cloud Runtime IPC Relay

Wework cloud runtime execution uses the same app IPC protocol as local mode. The frontend connects to the Backend `/wework-runtime` Socket.IO namespace and wraps `runtime.*` requests as `{ id, method, params, device_id }` frames. Backend only authenticates the user, verifies the online target device, and forwards the request to the matching executor; it does not translate this Wework runtime path into `chat:*` events.

Cloud executors still connect to Backend through the `/local-executor` namespace. Inside the executor, the same local `RuntimeWorkRpcHandler` handles `runtime.tasks.create`, `runtime.tasks.send`, `runtime.tasks.list`, `runtime.tasks.transcript`, and related methods. Responses API-style app IPC events are relayed back through `runtime:event` to `/wework-runtime`. The Wework frontend reuses the local streaming event mapper, so local and cloud runtime execution share the same runtime flow.

In a multi-instance Backend deployment, the Socket.IO Redis manager forwards RPCs to the worker that owns the executor connection. The Redis device-online record containing the `socket_id` is the routing source. The current worker's in-process connection table must not be used to declare the executor disconnected, because the connection may belong to another worker.

## Local Executor Lifecycle

Packaged release builds of Wework keep one active app paired with one local executor. On release startup, only one Wework instance may stay active; repeated launches focus the existing window. The app directly starts and owns the executor child process and communicates through stdin/stdout JSONL, without a shared socket, TCP address file, or process discovery.

Debug builds do not enable the single-instance policy. Local development may run multiple Wework debug instances at the same time; each instance owns only its child process stdio, so endpoints cannot overwrite each other and an app cannot attach to another executor. Whether instances share persisted tasks is still controlled by Executor Home isolation and is independent of the IPC transport.

Closing to the tray destroys only the current WebView; the Wework process, executor, and Codex app-server keep running. After the window is recreated, the `running` field returned by `runtime.tasks.transcript` restores task execution state. That field is authoritative only when backed by an in-memory executor task or the Codex app-server's live thread status; it must not be inferred from stale `streaming` messages in transcript history. After a normal or abnormal full app exit, the new executor has no activity state from the previous process, so old messages cannot mark an interrupted task as running again.

## Local CLI Entry

On macOS, the Wework desktop app installs a user-level `wework` launcher at `~/.local/bin/wework` during startup. Wework generates and owns this file instead of symlinking it to build output or app resources, so debug target cleanup, release app updates, and bundle path changes do not leave a broken command. If that path already exists and is not a Wework-managed launcher, Wework leaves it untouched and writes an explicit warning to the app log.

Users can run:

```bash
wework
wework .
wework /path/to/project
```

`wework` and `wework .` resolve the current directory to an absolute path and ask Wework to open it as a local workspace. Release builds forward the request to the existing window through the macOS app single-instance path; debug builds still allow multiple instances, so the CLI starts the current debug executable with `--open-workspace <path>`.

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
- OpenAI Responses-compatible base URL and request path. The default request path is `/responses`; custom providers can use their own path.
- Optional API Key.
- Optional context window size.
- Enabled state and update time.

When API Key is blank, local runtime sends a `dummy` bearer token to the Codex provider config so no-auth local OpenAI-compatible services can run. Local model configs and the built-in local Codex model enter the existing model selector as `UnifiedModel(type: "runtime")`.

The context window size only accepts positive integers. After the frontend saves it, the value is exposed as `config.model_context_window` on the local model. Local IPC writes it into `model_config.model_context_window` when creating a Codex task, and executor forwards it as the Codex launch override `model_context_window`. The Wework background-context indicator must also resolve the model config from the current task's own `modelSelection`, so Codex's default catalog cap for unknown models does not make the UI display the default window instead of the user-configured value.

When creating a runtime task, the selected model must be stored as part of task state in `runtimeHandle.modelSelection` and also copied into the optimistic task summary. The `runtime.tasks.create` response must return the same runtime handle. This keeps the model selection available even when the runtime work list refresh has not returned the new task yet but stream context-usage events have already arrived, without inferring from the global currently selected model.

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

It never returns plaintext contents. Wework also does not upload the local auth file by default. Auth contents enter encrypted server storage and device sync only after the user explicitly uploads the file or imports it from an online device on the cloud-connected "Models" page.

Wework's remaining-usage display also follows the local Codex account. The frontend first reads the local `auth.json` status; if no Codex account exists, the menu and tray show none. When a local account exists, the frontend reads the Codex app-server `account/rateLimits/read` snapshot through the local executor command `runtime.codex.rate_limits.read` and displays the remaining percentages for the 5-hour and 7-day windows. The desktop system tray refreshes these two values every 60 seconds, shows only usage percentages, does not upload auth contents, and does not substitute Backend Claude quota.

## Disconnect

Disconnecting cloud only clears cloud connection storage. It does not affect:

- Local conversations.
- Open local workspaces.
- Local Codex models.
- Local model configs.
- The local executor.

After disconnecting, cloud devices, server models, proxy, and cloud auth sync return to unavailable or connect-entry states.
