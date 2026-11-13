---
sidebar_position: 19
---

# Connector Apps Architecture and Deployment

Connector Apps let Wework connect to internal systems without changing Codex source code or requiring a ChatGPT login. The upstream may be either an MCP server or an ordinary HTTP API. Responsibilities are separated: Wegent Admin manages definitions, visibility, and fixed provider headers, Wegent Backend reads ConnectorApp resources from `kinds` and adapts upstream protocols, and Executor exposes one local MCP endpoint to Codex. After connecting to Wegent Cloud, Wework synchronizes available capabilities and provides app authorization and retry actions on its connection settings page.

## Runtime flow

1. Under **System Administration → App Connections**, an administrator configures either a remote MCP endpoint or an HTTP API base URL with tool definitions, plus role visibility, a tool allowlist, and optional fixed provider headers.
2. `auth_type: none` is for upstreams that need no per-user authorization; administrators may configure encrypted fixed headers. `auth_type: oauth2` supports standards-compliant MCP OAuth: Backend discovers the authorization server using RFC 9728/8414, registers a public client using RFC 7591, completes Authorization Code + PKCE S256 with the RFC 8707 resource parameter, and automatically refreshes encrypted user tokens. Administrators may optionally restrict the OAuth scope; leaving it empty requests all scopes declared by the authorization server.
3. After a user connects Wework to Wegent Cloud, Wework automatically synchronizes Connector Apps and Skills available to that user.
4. Wework exchanges its cloud session for a 15-minute connector JWT. This token only has the `connectors:invoke` scope and cannot replace a user login token.
5. Executor registers itself as the ordinary stdio MCP server `wegent_apps`. Codex connects only to this local process and never receives fixed provider headers.
6. The `wegent_apps` child process reads the automatically rotated short token from Executor's private directory and calls Wegent Connector Runtime. Backend decrypts administrator fixed headers and either connects to the upstream Streamable HTTP/SSE MCP server or translates the tool invocation into an ordinary HTTP request.
7. Every available app gets a Wegent-managed local Skill containing its description, tool namespace (such as `crm__`), and any required authorization guidance. It never contains credentials.

Tools are exposed as `<app_slug>__<upstream_tool_name>`. The same allowlist is enforced during both tool discovery and invocation, so a caller cannot bypass policy by constructing a tool name directly.

## Tool loading modes

Administrators choose a loading mode through `Kind.json.spec.toolLoadingMode`. The admin console creates new apps as `lazy` by default and asks for confirmation before switching to `static`, because static loading injects every tool at once. API callers that omit the field still get the server-side default of `static`:

| Mode | Behavior | Best for |
| --- | --- | --- |
| `static` | Every authorized app's tools join the shared `wegent-connectors` MCP and are visible to every task (Static loading) | A few frequently used apps |
| `lazy` | Upstream schemas load on demand: Chat uses a connector Skill, while coding shells and desktop use compact discovery/invocation tools | Many, tool-heavy, or infrequently used apps |

`lazy` apps stay out of the shared MCP. They use a scoped MCP endpoint identified by the `X-Connector-App` header, which lists and invokes only the named app's tools. The shared `wegent-connectors` surface returns only `static` apps. Keywords use substring matching; a phrase with spaces requires every word to be present (for example `DingTalk table`). A match preloads the Skill and mounts its full scoped MCP. Unauthorized apps are prompted in the conversation on demand; Wework keeps the `connector_auth_required` card.

- In Chat, unmatched lazy apps mount through `load_skill`. Explicit document-provider selection mounts its authorized, visible, enabled app directly; a missing mount cannot be reported as ready.
- In cloud Codex/ClaudeCode, lazy apps without matching keywords still expose `_wegent_discover__<slug>` and `_wegent_call__<slug>`. `X-Connector-Loading: lazy` avoids upstream discovery during catalog loading. Discovery returns actual allowlisted tools and schemas; invocation accepts `{name, arguments}` and preserves the existing permission checks.
- Desktop synchronization requests installed apps and the Runtime catalog with `X-Connector-Loading: compact`. It receives static tools and compact lazy entries, connecting to lazy upstreams only on discovery. Settings retain the full directory by default; mode changes update both the local Skill and tool catalog.

When creating an app in the admin console, `keywords` defaults to the display name and the identifier; `-` and `_` in the identifier become spaces (for example slug `dingtalk_ai_table` yields `dingtalk ai table`). Once an administrator edits the keywords manually, they no longer follow later name changes.

Authorization hints appear only in the conversation: an unauthorized `static` app is always surfaced, while an unauthorized `lazy` app is surfaced only when the current message matches its name or `keywords`. The page no longer shows a global pending-app-count banner; **Settings → Integrations** still lists every visible app for manual authorization.

## HTTP API adapter

When the connection protocol is `HTTP API`, the endpoint is an API base URL. Each `http_tools` entry defines:

- `name` and `description`: the tool identity and model-facing purpose.
- `method` and `path`: `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` are supported. The path must be an absolute-path reference on the configured host; it cannot contain another origin, a query string, or a fragment.
- `input_schema`: a standard object JSON Schema. Runtime validates every invocation before sending the request.
- `argument_locations`: maps arguments to `path`, `query`, or JSON `body`. Unmapped GET/DELETE arguments become query parameters; arguments for other methods become JSON body fields. Path values are URL encoded.
- `timeout_seconds`: a per-request timeout between 1 and 120 seconds.

Backend does not follow redirects, preventing fixed headers from crossing to another host, and limits responses to 1 MB. JSON responses become both MCP text and structured content; non-2xx responses become MCP tool errors. Fixed provider headers, role visibility, and tool allowlists use the same policy as MCP upstreams.

## Authentication boundary

Connector currently supports these app authentication modes:

| Type | Use case | Credential location |
| --- | --- | --- |
| `none` | The upstream needs no per-user authorization, or identity is managed centrally by administrators | No user credential; optional administrator fixed headers |
| `oauth2` | The upstream requires per-user OAuth authorization | User access/refresh tokens are encrypted in `ConnectorConnection` |

Administrators can configure encrypted fixed headers, such as an internal API key or service token, without requiring every user to connect separately. Fixed provider headers are never returned by the administrator API. It only reports whether headers exist and the configured header names. OAuth 2.0 authorization uses `/api/connector-apps/{slug}/oauth/sessions` and `/api/connector-apps/oauth/callback`; user credentials are encrypted only in `ConnectorConnection` and never returned by any API.

An expired grant that still holds a refresh token counts as usable: the runtime renews it before the next upstream call and the conversation guidance does not claim authorization is missing. The refresh token is dropped only when the token endpoint rejects it, which returns the app to "needs authorization" with a fresh link. Python tool discovery and the Rust `/api/connector-runtime/tools` both apply this rule and perform the renewal.

A stored credential that the current `GIT_TOKEN_AES_KEY`/`GIT_TOKEN_AES_IV` cannot decrypt is a configuration fault, not a missing grant: the runtime answers 503 and records the reason in the connection's `lastError` instead of asking the user to authorize again or sending the ciphertext upstream. When several local worktrees share one MySQL instance, they must use the same key pair; otherwise the instance that wrote a credential can read it and the others cannot.

An upstream 401/403 for an `auth_type: none` app is an administrator credential or permission error, not a user OAuth problem. It neither expires a user grant nor prompts for re-authorization. SSE endpoint events must resolve to the configured origin without URL user information, preventing authenticated messages from reaching another host.

## Deployment configuration

Production deployments must protect the shared sensitive-data encryption settings `GIT_TOKEN_AES_KEY` and `GIT_TOKEN_AES_IV`. Connector Apps use the existing `encrypt_sensitive_data` mechanism to store fixed headers in `Kind.json.spec.providerHeadersEncrypted`. Inject keys through a secret manager and never commit them. Plan a migration for existing encrypted fields before rotating keys.

```bash
GIT_TOKEN_AES_KEY="$(openssl rand -base64 24 | head -c 32)"
GIT_TOKEN_AES_IV="$(openssl rand -base64 12 | head -c 16)"
```

Production deployments must configure `CONNECTOR_OAUTH_REDIRECT_URI`. Its value must exactly match the callback registered by DCR, for example `https://wegent.example.com/api/connector-apps/oauth/callback`. Production deployments should use HTTPS. Internal MCP endpoints may use HTTP, but only trusted administrators can configure them and egress should be constrained by network policy.

## Data and lifecycle

- Connector App definitions are stored in the `kinds` table with `kind = "ConnectorApp"`, `namespace = "system"`, `user_id = 0`, and `metadata.name` matching the app `slug`. Every catalog entry point selects only active apps owned by the system; namesakes owned by other users or namespaces cannot enter the catalog.
- Apps can target MCP upstreams or HTTP API upstreams; the main configuration lives under `Kind.json.spec`.
- Administrator fixed headers are encrypted into `Kind.json.spec.providerHeadersEncrypted`.
- Connector Apps, user connections, and short-lived OAuth sessions reuse the `kinds` table and cache as `ConnectorApp`, `ConnectorConnection`, and cached session state; no separate physical tables are introduced.
- Dynamically registered OAuth clients are stored in `Kind.json.spec.oauthClientEncrypted`. Deleting an app from its card is a hard delete: the `ConnectorApp` record, its cached OAuth client, and every user's `ConnectorConnection` are removed together, so deletion requires two confirmations and cannot be undone. The built-in apps (DingTalk docs, sheets, AI tables, and wiki) are re-created by the startup bootstrap after deletion; apps created manually by an administrator are not restored. After an app is added back, the next authorization registers a new client.
- Tool summaries from the latest successful discovery are cached per user in `ConnectorConnection.toolSummaries`. Multi-instance deployments share the same database, so there is no per-instance cache drift. Dynamic client registration uses a shared distributed lock to prevent concurrent duplicate registrations.
- Full re-authorization clears the previous account's tool summaries; ordinary token refresh preserves them. Discovery results and errors are conditionally written against the credential actually used by the request, so a late response cannot overwrite a newer account.
- OAuth callbacks are processed once, while successful session polling remains idempotent. Before persisting a grant, the backend rechecks app identity, visibility, and resource URL; deleted, recreated, disabled, or reconfigured apps cannot accept consent from the old session.
- Changing the MCP URL or authentication type clears the cached OAuth client and physically deletes the app's previous user connections, preventing old credentials from reaching a new resource.
- Connector egress ignores process-level proxy settings. Connection establishment is retried twice, covering only DNS/TCP/TLS handshakes; requests that were already written are never replayed. When one edge of an upstream gateway briefly serves an invalid certificate, the retry re-resolves and connects to another edge. If all attempts fail, the 502 response distinguishes TLS verification failures, connection failures, and timeouts, while authentication failures still surface as an authorization requirement.
- Disabling an app immediately removes it from user catalogs and Runtime.
- Administrators can replace or explicitly clear fixed provider headers; leaving the editor blank preserves the encrypted value.
- Wework removes generated local Skills for unavailable or disabled apps during the next synchronization.
- Wework's app connection section belongs to the current account and backend. Account changes or navigation invalidate old requests and authorization results. Expired connections expose separate refresh and OAuth authorization actions; a failed refresh never automatically opens consent. Successful refreshes reload the catalog and notify the local runtime to synchronize.
- The Connector JWT is written only to a mode-`0600` runtime file in Executor's private directory and never to Codex configuration. The child process reads it again for each request, and an expired token cannot be used.
- Disconnecting Wework from cloud deletes the runtime token file and removes the `wegent_apps` MCP configuration and generated Skills, while local Codex workflows remain available.

## API layers

The paths below use the default `API_PREFIX=/api`; replace `/api` with your deployment's configured API prefix when it differs.

- `/api/admin/connector-apps`: administrator catalog CRUD.
- `/api/connector-apps`: current-user visible catalog. The `connection` field in the response is a frontend-compatibility projection and does not map to a `connector_connections` row.
- `/api/apps/list`, `/api/apps/read`, `/api/apps/installed`: Wework/Codex app projections.
- `/api/connector-runtime/token`: exchanges a normal cloud session for a least-privilege short token.
- `/api/connector-runtime/tools` and `/call`: accept only connector JWTs and are used by the Executor MCP proxy.
- `/api/mcp/connectors/sse`: dynamic MCP endpoint for Chat and cloud coding shells. Task tokens identify the caller; listing and invocation both enforce visibility, authorization, and the allowlist. Without `X-Connector-App`, only static apps are exposed; scoped requests address the named app and may use `X-Connector-Loading: lazy` for compact entries. Desktop coding tasks use the device-local `wegent_apps` proxy without duplicating the cloud endpoint.

## Built-in DingTalk connector apps

DingTalk hosts the document, sheet, AI table, and wiki MCP servers at fixed OAuth URLs, so users never paste a personal URL. On startup (`CONNECTOR_BUILTIN_APPS_ENABLED=True`) the backend backfills missing app definitions:

| slug | Name | MCP URL |
| --- | --- | --- |
| `dingtalk_docs` | DingTalk Docs | `https://mcp-gw.dingtalk.com/oauth/server/doc` |
| `dingtalk_sheet` | DingTalk Sheet | `https://mcp-gw.dingtalk.com/oauth/server/sheet` |
| `dingtalk_aitable` | DingTalk AI Table | `https://mcp-gw.dingtalk.com/oauth/server/aitable` |
| `dingtalk_wiki` | DingTalk Wiki | `https://mcp-gw.dingtalk.com/oauth/server/wiki` |

`CONNECTOR_BUILTIN_APPS_ENABLED` defaults to enabled. Rust and Python initialization share `shared/data/builtin-connector-apps.json` independently of development YAML initialization, and the owning initializer backfills missing apps. Backfill creates missing system apps, preserves subsequent administrator changes to enabled state, loading mode, and keywords, and avoids duplicating system apps with the same endpoint. A deleted built-in app is recreated on the next startup; set `CONNECTOR_BUILTIN_APPS_ENABLED=False` to keep it removed.

These four services no longer use the provider configuration popup and inject no "open configuration" guidance. Built-in apps default to `toolLoadingMode: lazy` and carry DingTalk service keywords. A matching user message preloads the corresponding `wegent-connector-<slug>` Skill; otherwise the model loads it on demand through `load_skill`. The conversation authorization link still covers missing grants, and OAuth, tool discovery, and allowlist enforcement keep the existing Connector flow. The Wegent web "Settings → Integrations" page drops the DingTalk provider card in favor of the app-connections card.

The authorization list depends on the current message, so it is appended to that turn's user message inside a `<wegent_connector_apps>` block instead of the system prompt: resumed agent sessions (Claude Code `--resume`, Codex threads) keep the system prompt they started with, which would otherwise pin the list to the first message of the conversation.

**Legacy API-key configurations keep working**: when a user previously saved a personal Streamable HTTP URL for one of these services (for example `https://mcp-gw.dingtalk.com/server/<token>?key=<key>`), the runtime keeps the Skill's `mcpServers` placeholder and reuses that URL when building the request, so no re-authorization is required and the conversation does not prompt for OAuth. Only users without a personal URL get tools from the Connector App; once that app is authorized it takes over the tool surface so the same tools are not exposed twice.

This design does not use Codex's native `codex_apps` server. Its ChatGPT authentication and remote app catalog belong to Codex itself. Wegent normalizes both MCP and HTTP upstreams into standard MCP at the Executor boundary, so Codex neither needs to be modified nor logged in.
