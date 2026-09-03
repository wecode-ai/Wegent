---
sidebar_position: 33
---

# Codex Plugin Runtime

Wework's plugin feature is compatible with Codex plugins, skills, and apps. The plugin pages handle discovery, installation, creation, and management; the chat runtime passes user-selected skills and apps to the Codex app-server as structured mentions instead of treating display text as plain prompt content.

## Page Entry

In the desktop sidebar, the plugin entry is fixed as the third primary action: New Chat, Search, Plugins, then Cloud Work. Inside the plugin page:

- The header shows marketplaces, installed plugins, and search.
- The top-right refresh button reloads the current marketplace.
- The create entry opens a Codex plugin creator-style page.
- The management entry opens the installed plugin, skill, and app enablement and uninstall view.

Plugin marketplaces are not split into local and cloud modes. Wework shows the OpenAI official marketplace returned by Codex app-server by default and lets users add multiple named marketplaces. Custom marketplaces can come from GitHub repositories, remote addresses, or local `marketplace.json` files/directories. When no marketplace is available, Wework shows a welcome page that guides the user to add a custom marketplace or open management.

Codex plugin runtime configuration is available under Settings → Integrations → Plugins and currently exposes the remote Apps / Connectors switch. Settings no longer includes a standalone worktree management page or an action panel that migrates Claude and Codex skill directories into shared symlinks. Worktree lifecycle is managed by conversation flows, while skill and plugin content is managed through the plugin pages and Codex app-server.

### Boundary between Codex plugins and Wework plugins

The desktop management page separates **Codex plugins** from **Wework plugins**. Codex plugins continue to use the Codex app-server, Wegent cloud marketplace, and Executor synchronization paths. Wework plugins are bundle dependencies of the `wework-core` DSH profile and are managed directly by the Electron main process. Wework plugin management is available only in the managed desktop runtime and does not expose installation or removal HTTP endpoints through the DSH web server.

The renderer invokes allowlisted Electron capabilities to list, install, update, enable, disable, and uninstall plugins. The main process serializes these operations and snapshots the profile `package.json`, lockfile, workspace configuration, and Wework plugin state before each mutation. It then validates the result with `dsh --profile wework-core --dump-config`. If package management or validation fails, it restores the snapshot and reinstalls dependencies from the lockfile.

User plugins must declare `dsh.bundle.patch`. Bundled DSH packages are read-only in the management UI. User plugin order and disabled state are stored in a Wework state file inside the profile and used to rebuild `dsh.profile.bundles`. Configuration changes do not restart the desktop runtime implicitly; the UI prompts the user to call `runtime.restartCoreDsh` after completing a group of changes.

## Marketplace and Install

Wework reads local marketplaces and the OpenAI official marketplace through the Codex app-server exposed by the local executor. List requests do not restrict `marketplaceKinds`, allowing Codex to return both local marketplaces and the `openai-curated-remote` official marketplace according to the active feature flags and authentication state. Custom remote GitHub marketplaces are cloned into a local cache directory, and later reads use the cached marketplace data and plugin folders. Local marketplace installation, uninstall, refresh, and removal all go through Codex app-server.

When Wework is connected to Wegent cloud, the plugin page also displays the Backend-provided Wegent cloud marketplace. Its details and installation state come from Backend. After a normal installation, Backend synchronizes the user's global `InstalledPlugin` desired state to online local and cloud devices. After the device Executor obtains the package from Wework Backend / object storage, it writes runtime caches, marketplace metadata, and enablement configuration directly into the isolated Claude and Codex homes. Cloud-plugin install, update, and removal do not call Codex app-server `plugin/install`, `plugin/uninstall`, or configuration RPCs and do not refresh GitHub or OpenAI marketplaces. Enterprise-internal, Wework-public, and published personal plugins therefore have no GitHub, OpenAI, or Codex network dependency once their Wework package is reachable. The OpenAI official marketplace remains managed by Codex and does not appear in the custom marketplace edit, reorder, or delete list.

Cloud synchronization commits the package replacement, both runtime caches, registries, and configuration files as one local transaction. Extraction, parsing, or write failures restore the pre-sync state so an update cannot leave a new package paired with old runtime metadata, and removal cannot stop halfway. Connector `localAuth` remains a separate Wework step after package synchronization and is not bypassed by local materialization.

### Install-time local authorization

Plugins can declare device-side authorization under `connectors[].localAuth`. `local_qr` is used for QR login, while `browser_oauth` is used when a local CLI opens an OAuth flow in the browser. Both modes must provide `health` and `start` commands relative to the plugin root; QR mode must also provide a non-blocking `poll` command. With `authPolicy: on_install`, Wework checks the login after the plugin package is synchronized to the device and opens the authorization UI when needed. Cancellation or failure aborts that installation. First-use and mid-run checks remain recovery paths for expired credentials.

The connector authorization preflight before sending a message runs synchronously only for messages that explicitly reference a `plugin://` URI or contain a connector authentication hint; ordinary messages are sent immediately without reading the installed plugin list, so sending is never blocked by local plugin enumeration. When a plugin reference is present, preflight only enriches the mentioned plugins with `plugin/read` and must not call full `plugin/list` / `readState` on the send path, which can stall conversation open by ~10 seconds.

Mid-run authorization recovery checks only the latest assistant or system message in the current conversation; task switching must not rescan the complete transcript. Detection text must have a fixed size bound and may include only message errors, message content, and textual or known structured error fields from tool blocks. It must not serialize `renderPayload` or other unbounded presentation data. This prevents paginated history caches or a single large tool result from blocking the renderer main thread, and prevents stale authorization errors from reopening after later successful replies.

Browser OAuth runs as an asynchronous authorization session with `preparing`, `waiting_browser`, `verifying`, and `ok/error` states. Closing the UI calls the Executor `cancel` RPC and terminates the login process. CLI bridges must emit one status JSON object and must never include tokens, cookies, or other credentials.

Local authorization tools have two sources:

- `bundled` resolves a sidecar shipped with the desktop client. The DingTalk plugin uses Wework's bundled DWS instead of downloading the older copy declared by the plugin repository.
- `managed` selects an immutable artifact by operating system and CPU architecture, verifies its declared SHA-256, and installs it atomically under the Executor home. The current implementation only accepts official GitLab CLI release URLs, and all three internal GitLab plugins share one managed `glab` installation.

Plugin installation is user-scoped, while CLI credentials are device-scoped. Install-time authorization therefore makes the current device ready; every other device checks and authorizes independently. `logoutOnUninstall` defaults to enabled for QR connectors and disabled for browser OAuth so uninstalling one plugin does not silently remove credentials shared by another plugin or profile.

`wegent-sites` and `weibo-miniapp-h5-develop-agent` are maintained in separate plugin repositories. Before a Backend image build, `pnpm prepare:builtin-plugins` copies each configured external plugin into the ignored `backend/init_data/plugins/<plugin-name>` staging directory. The standard `build_image.sh` and `build_image_mac.sh` scripts run this step automatically. Official image workflows download each configured archive, verify its pinned SHA-256, and run the same staging operation. Download, verification, or staging failures stop the image build. Backend then idempotently publishes every staged plugin as a workspace-scoped, featured Wegent cloud marketplace item owned by the system `user_id=0`.

Built-in application plugin identity is defined by the Backend built-in plugin registry. The current registry contains only `wegent-sites` and `weibo-miniapp-h5-develop-agent`; both use `visibility=workspace`, so their canonical marketplace name is `wegent`. `public` remains valid in the data model but is reserved for system/official public catalogs; a regular user's enterprise submission cannot select it. Only when the built-in installation path finds one of these two system-owned `user_id=0` marketplace rows still stored as `visibility=public` does Backend treat it as a legacy row and normalize it to `workspace` before installing. This prevents the same built-in plugin from appearing as `plugin://...@wework` in old data and `plugin://...@wegent` in the current application create flow.

The Applications page reads its lists through `GET /api/sites`. Sites and Mini Programs share this endpoint and pass `app_type=web` and `app_type=miniapp`, respectively. Omitting the parameter defaults to Sites for backward compatibility. The response `app_type` discriminates the fields for each application type. The page also calls `GET /api/sites/app-types` to discover the types enabled by the current Backend, their display order, and capabilities such as `create`, `publish`, `edit`, `delete`, and `open_experience`. Wework only shows types that are both enabled by the server and represented by a local Definition, and hides operations that are not supported by the advertised capabilities.

When Wework is connected to Wegent cloud, it calls `POST /api/users/me/wegent-runtime-token` to issue the token that local application Skills use for Backend runtime APIs, then writes it to the local Codex shell environment as `WEGENT_RUNTIME_AUTH_TOKEN`. Wework refreshes this token before the returned `expires_in`. `AUTH_TOKEN` remains the existing per-task bearer token, and `WEGENT_AUTH_TOKEN` remains reserved for executor device connections; these credentials must not be used interchangeably.

To add an application type, add its response model and `ApplicationTypeHandler` to the Backend, then register the handler in `APPLICATION_TYPE_HANDLERS`. Add the matching Wework Definition in `applicationTypeDefinitions.tsx`, where only its icon, copy, columns, and row renderer are declared. Creation plugin identity comes from `GET /api/sites/app-types` through `create.plugin_name` and `create.marketplace_name`; Wework caches the last successful app-types descriptor and reuses it when cloud discovery is briefly unavailable. Cache reads must first verify that every descriptor in `items` is an object and that optional `create.plugin_name` and `create.marketplace_name` fields are strings when present; invalid cached data is treated as no cache so discovery can fall back to the server or default Definitions. When the type uses a new built-in plugin, also add it to the Backend built-in plugin registry and `builtin-plugin-staging.mjs`. The shared workspace and creation flow should not gain new type-specific branches. The server can independently change ordering, availability, capabilities, and creation plugins, while older clients safely ignore unknown types.

The create entry first calls `GET /api/plugins/installed?device_id=<target>` and trusts the target device installation state. When the matching plugin is already `installed` on that device through `currentDeviceInstallation` / `status.devices`, Wework opens the new task immediately with the plugin `displayName` and default prompt instead of reinstalling. If the plugin is not installed locally, creating a Site calls `POST /api/plugins/builtin/wegent-sites/ensure-installed`; creating a Mini Program calls `POST /api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed`. Both requests include the target `device_id`. The endpoint only installs built-in plugins published by the system owner. Built-in application plugins use `visibility=workspace`, so Backend returns `wegent` in both `create.marketplace_name` and the installed row's `source.marketplace`. Different visibility values map to different marketplace names: `personal` uses `wework-personal`, `workspace` uses `wegent`, and `public` uses `wework`; the frontend must reuse the shared marketplace identity helper instead of hard-coding one marketplace name. Repeated calls reuse and re-enable the matching installation record; Backend may first run a full `replace` sync and then run a single-plugin `merge` only when the target device still lacks that plugin. The frontend checks only the target device acknowledgement and requires the requested plugin installation ID or name to return `synced`; if an older response omits `sync.results`, Wework treats it as having no target-specific device result and continues with the top-level `sync.plugins` fallback validation. Failures from other devices or unrelated historical capabilities do not block application chat creation. A missing or offline target, or failure to synchronize the requested plugin to the target device, still prevents chat creation. After confirmation, the frontend opens a new task with the stable `plugin://wegent-sites@wegent` or `plugin://weibo-miniapp-h5-develop-agent@wegent` reference. The Mini Program entry also uses the plugin-provided default creation prompt. While plugin installation and synchronization are running, the Applications page shows the “Installing the application plugin. The chat will open when it finishes...” status notice. Clicking the mention loads the matching cloud plugin detail.

Local custom and OpenAI official marketplace uninstall continues to go through Codex app-server. Wegent cloud-plugin uninstall instead removes the account installation intent and device desired state, then lets the Executor delete only Wegent-managed central packages, Claude / Codex caches, and matching configuration locally. Personal local plugins and OpenAI marketplace configuration are preserved. Connector login state still follows the plugin authorization policy.

## Separate Codex Home

Wework uses a separate Codex home so it does not write directly into the user's command-line Codex config directory. By default this is the `codex` child directory under the executor home, and it can be overridden with `WEGENT_CODEX_HOME`.

To reuse the user's existing login, Wework links the user's `~/.codex/auth.json` into the Wework Codex home. If the target is a stale symlink, it is removed and recreated; on non-Unix systems the auth file is copied. Plugins, marketplace caches, and Wework runtime config remain under Wework's own Codex home.

On first startup, if the Wework Codex home has not been initialized and a native `~/.codex` directory exists, the app shows a migration choice during startup. The user can choose to:

- Create a new Wework Codex home and only reuse the auth link.
- Migrate config from the native Codex home into the Wework Codex home.
- Enable or disable Codex remote app fetching. This switch only controls remote app initialization and does not refer to any specific bundled capability.

After initialization, the state is written into the Wework Codex home, and both the plugin pages and chat runtime read plugin state from the same Codex app-server. The settings page also exposes the remote apps switch so users can later update their Wework Codex config.

### Runtime Config Normalization

Before starting the Codex app-server, the executor parses and normalizes `config.toml` in the Wework Codex home. It creates a missing config, writes `pragmatic` when personality is absent, and migrates the legacy `instructions` field to `developer_instructions`. In current Codex versions, `instructions` completely replaces the model's base instructions; leaving user copy there removes built-in personality, commentary, and progress-update rules. Wework therefore no longer uses that field for custom instructions.

Custom instructions from Settings → Context are read and written through Codex app-server `config/read` and `config/batchWrite`. Writes merge the user's copy with Wework embedded-browser routing instructions and use `reloadUserConfig` to update loaded threads. Startup normalization is idempotent, uses TOML parsing and atomic file replacement, and preserves existing file permissions; newly created config files use mode `0600` on Unix.

The interaction style uses the same `config.toml` as its single source of truth. Selecting Friendly or Pragmatic updates personality through `config/batchWrite`; Wework no longer stores personality in localStorage or repeats it as an override on every thread or turn request.

## Runtime Permission Modes

The Wework composer provides three permission modes for local Codex tasks and persists the selection in `modelSelection.options.permissionMode`. New tasks and historical tasks without this field default to Full access. When a user explicitly switches from another mode to Full access, the UI displays a risk confirmation:

| Permission mode | Codex permission profile | Approval policy | Behavior                                                                                                                        |
| --------------- | ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Read only       | `:read-only`             | `on-request`    | Reads the workspace; file writes, commands outside the permission boundary, and additional permission requests require approval |
| Workspace       | `:workspace`             | `on-request`    | Reads and writes inside the workspace; access outside it or permission expansion requires approval                              |
| Full access     | `:danger-full-access`    | granular        | Runs file, terminal, and network operations without approval; MCP plugin business forms can still request user input            |

The frontend sends `runtime_permission_profile` with every local runtime request. The Executor applies the corresponding `permissions` and `approvalPolicy` to `thread/start`, `thread/resume`, `thread/fork`, and `turn/start`. Resuming or continuing from a task runtime handle must reconstruct the same profile from the persisted permission mode and must not fall back to a more permissive profile.

Full access uses granular approval policy. It disables `sandbox_approval`, `rules`, `skill_approval`, and `request_permissions`, while preserving `mcp_elicitations: true`. MCP elicitation is plugin-initiated business interaction rather than an execution-safety approval for commands, files, or permission escalation, so it must not be disabled by setting `approvalPolicy: "never"`.

Ordinary Wework Claude Code conversations run as non-interactive child processes and cannot display or complete Claude CLI approval prompts. On this execution path, the Claude Code `default` setting therefore maps to `bypassPermissions`; explicit `acceptEdits`, `plan`, `auto`, and `bypassPermissions` selections are still passed through unchanged. Interactive local terminals do not use this mapping.

Codex app-server requests from `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval` are mapped to Wework `request_user_input` cards. The card preserves the order of `availableDecisions`, displays only decisions actually advertised by the protocol, and returns stable protocol values. The Executor supports one-time `accept`, session-scoped `acceptForSession`, command-rule `acceptWithExecpolicyAmendment`, network-host `applyNetworkPolicyAmendment`, `decline`, and `cancel` responses. Structured rules reuse the amendment carried by the Codex request; missing or mismatched payloads are safely declined instead of deriving broader authority from display text. Permission requests can grant turn or session scope, or enable `strictAutoReview` for the current turn so each subsequent command is reviewed; a denial grants no additional permissions.

## Model List

Wework requests the model catalog from the Codex app-server's `model/list` method through the local executor, then uses the returned provider and model array order unchanged in the model picker. The frontend does not reorder official or default models or custom providers, and does not add models that Codex did not return. The request uses `includeHidden: false`, so models Codex marks as hidden are not displayed.

Existing tasks preserve the model selection saved when the task was created or last sent. If that model is temporarily absent from the current catalog, Wework requires the user to select an available model and blocks sending; it does not silently replace the task model with the default model for new tasks.

### Supervisor Models

Task supervision and chat use the same model selector component and the same model catalog, while remembering their most recent selections independently. Supervision must not maintain a second model-filtering or ordering path; official Codex models, custom providers, and local models available in chat must also be selectable for supervision.

Cloud `public`, `user`, and `group` models continue to execute through the Backend `/api/model-runtime/responses` endpoint. When a `runtime` model is saved for supervision, Wework builds its `modelConfig` with the same rules used by chat and sends it to the Executor over local IPC. The Executor keeps that configuration in process memory only and starts an independent, ephemeral Codex app-server turn for each inspection instead of reusing the task thread. This prevents inspections from polluting the primary transcript and avoids writing local-model credentials into persisted task data or logs.

### Image Attachment Preprocessing

Wework includes the current model category in local runtime requests. Official Codex models receive the original image. Codex providers, local model interfaces, and cloud models are treated as non-official models; before sending an image, the executor creates a temporary model-input file and proportionally reduces the image's short edge to at most `720px`. The long edge is not capped, so panoramic and long screenshots preserve their full aspect ratio instead of being forced into a fixed `1280×720` box. Images whose short edge is already at most `720px` remain unchanged. The original attachment, transcript, and preview URL are never rewritten. Temporary model-input files exist only for the current turn and are removed after it finishes.

## Chat Runtime

For a new chat, the composer shows the plugin entry with previews for up to three available plugins. After the conversation starts, the entry collapses to a single icon to reduce toolbar usage, while clicking the icon still opens the complete plugin picker. Narrow toolbars use the icon form as well.

When a user selects a skill, app, or plugin in the composer, the editor inserts an indivisible inline mention. The cursor can only stop before or after the mention; copy and submit serialize it as Codex app-server-compatible Markdown:

- Skills use `[$name](/absolute/path/to/SKILL.md)`.
- Apps use `[$name](app://connector_id)`.
- Plugins use `[$name](plugin://plugin_name@marketplace_name)`.

Clicking a skill mention opens its local `SKILL.md` in the right workspace. Before sending `turn/input`, the executor parses those markdown mentions and builds Responses API-style `input` text elements. The legacy `skill:///absolute/path/to/SKILL.md` form remains parseable for persisted messages. This lets Codex receive the actual skill/app/plugin reference instead of only the display text.

Plugins that the user has not selected are not injected into ordinary conversations automatically. Installing a plugin only makes its skills and apps discoverable to the Codex app-server; activation still depends on Codex app-server plugin state and the user's selection in the conversation.

When the user clicks "Try in chat" from plugin detail or marketplace rows, Wework writes one plugin mention according to the Codex protocol instead of writing both plugin and skill mentions. The trial content is placed into a new chat draft, and related templates are shown above the composer. After the user sends the message, the message bubble still renders `plugin://` mentions as badges so protocol strings are not shown as plain text.

## Backend Marketplace and Upload

Backend accepts both Codex and Claude Code plugin packages for upload, cloud marketplace publication, installation, and device synchronization. It normalizes each stored package with manifests for both runtimes. Backend installation records are the source of truth for the Wegent cloud marketplace; local custom marketplaces and the OpenAI official marketplace still use the local Codex app-server.

After catalog rebuilds or migrations, Backend reconciles installed Kinds by checking `pluginId`, `releaseId`, `source.catalogItemId`, and `source.marketplace`. Even when the Plugin and Release IDs are unchanged, a `source.marketplace` value that no longer matches the plugin's current visibility-derived marketplace must update the installed record and reset failed device installation state. This keeps installed rows moving from `wework` to `wegent` when visibility changes from `public` to `workspace` instead of incorrectly treating the row as a no-op.
