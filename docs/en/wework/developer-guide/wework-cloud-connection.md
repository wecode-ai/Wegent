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

The packaged Electron desktop mirrors the renderer's complete `localStorage` into
`renderer-local-storage.json` under the app `userData` directory and restores it
before other frontend services initialize. If a Core DSH restart changes the page
origin by selecting a new random port, cloud connection state, local models,
unsent drafts, layout state, and other UI preferences backed by `localStorage`
therefore remain available. The main process serializes updates, writes through
atomic file replacement, and uses mode `0600` on Unix. Explicitly disconnecting,
deleting a configuration, or clearing its state also removes the durable copy.
The web app, which has no Electron host, does not use this desktop mirror. Before
loading a new Core DSH origin, the main process also removes Chromium
`localStorage` belonging to the previous origin. When a durable snapshot exists
without origin metadata, it performs one full migration cleanup; later launches
clear only the previously recorded `scheme://host:port`. The current origin is
stored in `renderer-local-storage-origins.json`, and renderer recreation on the
same origin does not clear storage again. Browser storage remains untouched before
the first durable snapshot exists so migration data is not lost.

Users may enter either the Backend root URL or an `/api` URL. The frontend normalizes that input into HTTP API and Socket.IO connection settings. Connecting first checks `/health`, then calls `/auth/wework/sessions` to create a short-lived authorization session. Backend returns a complete `authorize_url`; local Wework opens that cloud authorization page in the embedded authorization browser and polls the session result with the client-only `poll_token`.

The desktop authorization window defaults to `1000 × 640` with a minimum size of `960 × 620`, which accommodates enterprise login pages that do not provide responsive layouts. It stays hidden until positioning completes, remains above ordinary windows after it is shown, and repositions when the Wework main window moves or its display scale changes. Placement is clamped to the usable area of Wework's current display. On macOS, positioning uses AppKit's unified logical desktop coordinates directly so moving between Retina and non-Retina displays cannot send the window off-screen through physical-to-logical pixel conversion.

Wework resolves the Socket.IO address in this order: the URL explicitly entered by the user, the packaged Socket URL when it belongs to the current Backend, the `socket_url` returned by Backend `/auth/wework/config`, and finally the Backend same-origin default. Backend declares its public Socket.IO origin through `WEGENT_SOCKET_URL`; HTTPS deployments should configure a `wss://` URL. Saved connections are refreshed and migrated with the same priority order on startup. Wework passes the resolved address to its local executor through Electron IPC. The executor uses that address for its Backend Socket.IO connection while HTTP APIs continue to use the Backend URL, so split-origin deployments do not require users to configure the WSS URL again.

Local Wework does not render cloud username/password forms and does not call `/auth/login` or `/auth/admin-password/setup`. Cloud login, OIDC, and admin initialization all happen on the cloud Wegent Web authorization page. After login, the user must explicitly approve Wework access; only then does Backend store a one-time claimable cloud JWT in the authorization session. Local Wework claims it, verifies the user through `/users/me`, and persists the cloud connection state.

Backend builds the authorization page URL from `WEWORK_AUTHORIZE_BASE_URL`; when unset, it falls back to `FRONTEND_URL`. Deployments with separate API and Web origins must configure the Web root URL explicitly. The Wework client only opens the complete `authorize_url` returned by Backend and does not infer the Web address itself.

## Interaction Entry

The desktop sidebar provides two cloud entry points with distinct responsibilities:

- The workspace entry shows cloud connection status. It says "Connect cloud" while disconnected and "Cloud connection expired" after login expiry; clicking it allows the user to reconnect or select "Disconnect" to clear a failed or expired state and return to the disconnected state.
- The account area always opens the account menu and does not change its click behavior with login state. While signed out, "Sign in to Wegent" appears at the top of the menu, and Settings, Check for updates, and Remaining usage stay accessible.
- After connection, the account area shows the cloud username and email, while the workspace entry shows the cloud host, cloud user, and online cloud device count.
- Expired or failed cloud connections do not block local features.

The Cloud Work status in the workspace entry comes from a complete background probe of teams, devices, and cloud runtime work, not from cached historical data. The first probe shows `Syncing`. After that probe completes, later refreshes keep showing the most recent `Available`, `No devices`, or `Unavailable` result until the full refresh finishes. If any cloud read fails, the latest result is `Unavailable`, even when the UI continues using the last successful snapshot to retain historical devices or task data. An overlapping refresh cancels the older request and replaces it with a new complete probe; it must not refresh only devices or fall back to a historical `Available` result.

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

New-chat composer preferences follow the same connection ownership. When disconnected, the selected model, reasoning effort, collaboration mode, and each project's current-workspace/worktree mode are written to the local Wework user preferences. Once cloud is connected, those selections are written through the Backend user API to the current cloud account and restored from that account after restart. Backend stores the model and its `options` in `wework_new_chat_model_selection`, and stores `executionMode` plus `worktreeBranch` per `project:<id>` in `wework_project_work_preferences`. Hybrid services must not keep writing connected-account preferences to local user storage; doing so makes the current window appear updated while a restart restores the cloud account's stale or default values.

## Cloud Runtime IPC Relay

Wework cloud runtime execution uses the same app IPC protocol as local mode. The frontend connects to the Backend `/wework-runtime` Socket.IO namespace and wraps `runtime.*` requests as `{ id, method, params, device_id }` frames. Backend only authenticates the user, verifies the online target device, and forwards the request to the matching executor; it does not translate this Wework runtime path into `chat:*` events.

Cloud executors still connect to Backend through the `/local-executor` namespace. Inside the executor, the same local `RuntimeWorkRpcHandler` handles `runtime.tasks.create`, `runtime.tasks.send`, `runtime.tasks.list`, `runtime.tasks.transcript`, and related methods. Responses API-style app IPC events are relayed back through `runtime:event` to `/wework-runtime`. The Wework frontend reuses the local streaming event mapper, so local and cloud runtime execution share the same runtime flow.

The relay timeout for `device.execute_command` must use the request's `timeout_seconds`, with a fixed acknowledgement grace period in the frontend. Ordinary runtime requests keep the default 75-second timeout. This prevents long commands such as Git Clone from being rejected by the outer IPC before their own timeout while preserving the executor's 600-second upper bound.

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
wework desktop instances
wework desktop inspect --project .
```

`wework` and `wework .` resolve the current directory to an absolute path and ask Wework to open it as a local workspace. Release builds forward the request to the existing window through the macOS app single-instance path; debug builds still allow multiple instances, so the CLI starts the current debug executable with `--open-workspace <path>`.

`desktop` is an instance-control subcommand of the same `wework` CLI. Wework
does not install or inject a second command with the same name. The
Wework-managed agent environment and the macOS user-level entry use the same
dispatch rules: `wework <path>` opens a workspace, while
`wework desktop ...` controls a running instance.

## Model Identity and Execution Transport

Models keep one canonical identity across the UI, task state, and execution requests: `name`, `type`, `namespace`, and `resourceUserId`. The frontend must not add `local:` or `cloud:` prefixes to distinguish execution locations, and model config must not carry a separate transport source. When catalogs are merged, an Executor-discovered model wins over a Backend-synthesized runtime Codex model with the same `modelId`.

The target device alone selects the transport: local devices call Executor through IPC, while remote devices call Executor through the WebSocket relay. Both paths use the same `runtime.tasks.*` protocol and model selection. Public, personal, and group model resource identity is forwarded to Executor and resolved by the same model gateway. User-configured local models use `local-model:<config-id>`; when a cloud or remote device is selected, Wework synchronizes the model's Codex capability catalog on demand and sends the task's model connection configuration directly to the target Executor.

The local Codex model catalog follows only the active provider in the current Codex configuration. executor reads `config/read` once through Codex app-server to get the active `model_provider` and display name, then calls `model/list` once for that provider's catalog. Even when `config.toml` contains multiple `[model_providers.*]` entries, Wework does not enumerate them as parallel model groups because Codex `model/list` does not expose a stable provider-scoped query protocol. Use the local model config flow below when Wework needs to show multiple model interfaces.

## Local Model Configs

Local model configs, including API keys, are stored only in Wework's local browser storage. They are not written to Backend as Model CRDs, do not become account-level persistent configuration, and are not cloud-synchronized. The Wework runtime does not access the desktop operating system credential store. If an older version stored an API key only in the system credential store, enter that key again under **Settings → Models** after upgrading. Each config includes:

- Display name.
- Model ID.
- Upstream API format: OpenAI Responses, OpenAI Chat Completions, or Anthropic Messages.
- Model base URL and request path. Defaults are `/responses`, `/chat/completions`, and `/v1/messages` for the corresponding formats; custom providers can use their own path.
- Tool profile: `custom`, `function`, or `shell`. Use `custom` for native Responses models that accept custom tools, `function` for Chat/Anthropic conversion, and `shell` for native Responses models that reject freeform custom tools.
- Optional API Key.
- Optional context window size.
- Enabled state and update time.

When API Key is blank, local runtime sends a `dummy` bearer token to the Codex provider config so no-auth local OpenAI-compatible services can run. Local model configs and the built-in local Codex model enter the existing model selector as `UnifiedModel(type: "runtime")`.

Test Connection forces the model to call a deterministic capability probe tool and succeeds only when the matching tool call is returned; a plain text response does not prove Agent tool support. The `custom` Responses profile probes with Codex's `apply_patch` custom-tool name and grammar, while the `function` profile uses a regular function probe. OpenAI Responses probes use `stream: true` and read the tool call from SSE events, matching Codex's real execution path and supporting providers whose non-streaming response leaves `output` empty. During execution, the executor generates an explicit Codex model catalog for the custom model. The `custom` and `function` profiles publish `apply_patch`, while `shell` publishes only shell-based editing.

DeepSeek V4-Flash and V4-Pro are built-in provider profiles. Their upstream endpoint is `https://api.deepseek.com/responses`, and their catalog IDs are `wework-deepseek-v4-flash` and `wework-deepseek-v4-pro`. Both have a 1,048,576-token context window and support `low`, `high`, and `max` reasoning effort with `high` as the default. The catalog enables parallel tools, multi-agent v2, and Web Search, while declaring text-only input and no image generation. After Wework discovers models from DeepSeek `/models`, it keeps `deepseek-v4-flash` and `deepseek-v4-pro`, the models supported by the Codex profile. Existing Chat Completions configurations managed by this profile are migrated on read to the Responses API, the `custom` tool profile, and live search.

The first time a local model is selected for a cloud or remote device, or after that local model configuration changes, Wework shows a confirmation before creating or continuing the task. After confirmation, Wework writes the current local custom-model catalog to the target Executor, restarts that device's persistent Codex app-server with `ifIdle` semantics, and verifies through `model/list` that the target model was loaded. The current message is sent only after verification succeeds. One confirmation is sufficient for the same device and configuration version during the current Wework session.

If the target Codex has a running task or pending request, Wework does not force a restart or clear the current input; it asks the user to wait and retry. Cancelling the confirmation likewise creates no optimistic task and sends no message. The model API key and endpoint are sent only to the selected target Executor as part of the confirmed execution and catalog-preparation flow; they are not written to a Backend model resource.

The context window size only accepts positive integers. After the frontend saves it, the value is exposed as `config.model_context_window` on the local model. Local IPC writes it into `model_config.model_context_window` when creating a Codex task, and executor forwards it as the Codex launch override `model_context_window`. The Wework background-context indicator must also resolve the model config from the current task's own `modelSelection`, so Codex's default catalog cap for unknown models does not make the UI display the default window instead of the user-configured value.

When creating a runtime task, the selected model must be stored as part of task state in `runtimeHandle.modelSelection` and also copied into the optimistic task summary. The `runtime.tasks.create` response must return the same runtime handle. This keeps the model selection available even when the runtime work list refresh has not returned the new task yet but stream context-usage events have already arrived, without inferring from the global currently selected model.

## Proxy Configuration Boundaries

The Proxy page manages local device proxy and cloud device proxy separately. These settings do not reuse each other:

- Local device proxy is stored in Wework local browser storage and only affects new Codex tasks created by the current Wework App through the local executor. It is not written to Backend, is not synced to cloud devices, and does not modify system proxy or user shell environment.
- Cloud device proxy is stored in cloud account configuration and only affects Codex tasks on cloud executors. Local devices do not use that URL.

Saving a local device proxy does not immediately interrupt running Codex tasks. The UI asks the user to restart Codex manually. After confirmation, Wework restarts only the persistent Codex app-server maintained by the current App's local executor; it does not terminate other Codex processes on the machine. The new Codex app-server receives proxy-related environment variables, and later new chats use that proxy.

Codex Responses-compatible models may be routed through the executor's built-in `codex responses proxy` before reaching the upstream model service. For custom model providers configured by the user in Codex `config.toml`, that proxy uses the same local device proxy carried by the task when connecting to the upstream service; otherwise model requests would bypass the Codex app-server process environment. Logs record only whether a proxy is configured and do not print the proxy URL.

## Local Auth Status

Local Codex `auth.json` status is read through the executor's read-only `runtime_auth_status` command. The command only returns:

- Whether the file exists.
- Target path.
- Updated time.
- File size.
- SHA-256 digest.

It never returns plaintext contents. Wework also does not upload the local auth file by default. Auth contents enter encrypted server storage and device sync only after the user explicitly uploads the file or imports it from an online device on the cloud-connected "Models" page.

Wework's Codex remaining-usage display follows the local Codex account. The Electron main process calls `runtime.codex.rate_limits.read` through the authenticated local executor IPC, reads the Codex app-server `account/rateLimits/read` snapshot, and displays the remaining percentages for the 5-hour and 7-day windows. The main process also counts running local tasks through `runtime.tasks.list` and reads cloud quota through `executor.backend.quota` with credentials retained by the executor; authentication tokens are not exposed to the main process. The system tray refreshes every 60 seconds and immediately after task start or completion events, so task counts and quota continue updating after the main window closes to the tray.

The macOS tray must display the logo, running status, and up to two quota lines together. The Electron main process should compose these elements directly into an RGBA template bitmap before passing it to the native tray. Do not depend on `nativeImage` rasterizing SVG text or Data URLs, because that path can preserve the text width while dropping the actual glyph pixels.

## Disconnect

Disconnecting cloud only clears cloud connection storage. It does not affect:

- Local conversations.
- Open local workspaces.
- Local Codex models.
- Local model configs.
- The local executor.

After disconnecting, cloud devices, server models, proxy, and cloud auth sync return to unavailable or connect-entry states.
