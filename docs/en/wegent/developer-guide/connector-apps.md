---
sidebar_position: 19
---

# Connector Apps Architecture and Deployment

Connector Apps let Wework connect to internal systems without changing Codex source code or requiring a ChatGPT login. The upstream may be either an MCP server or an ordinary HTTP API. Responsibilities are separated: Wegent Admin manages definitions, visibility, and fixed provider headers, Wegent Backend reads ConnectorApp resources from `kinds` and adapts upstream protocols, and Executor exposes one local MCP endpoint to Codex. Wework has no Connector settings page; it only synchronizes available capabilities after connecting to Wegent Cloud.

## Runtime flow

1. Under **System Administration → App Connections**, an administrator configures either a remote MCP endpoint or an HTTP API base URL with tool definitions, plus role visibility, a tool allowlist, and optional fixed provider headers.
2. The current version supports `auth_type: none` only. When administrators configure encrypted fixed headers for an internal system, the app becomes available automatically to allowed roles; Wegent does not store user bearer tokens or provide an OAuth authorization flow.
3. After a user connects Wework to Wegent Cloud, Wework automatically synchronizes Connector Apps and Skills available to that user.
4. Wework exchanges its cloud session for a 15-minute connector JWT. This token only has the `connectors:invoke` scope and cannot replace a user login token.
5. Executor registers itself as the ordinary stdio MCP server `wegent_apps`. Codex connects only to this local process and never receives fixed provider headers.
6. The `wegent_apps` child process reads the automatically rotated short token from Executor's private directory and calls Wegent Connector Runtime. Backend decrypts administrator fixed headers and either connects to the upstream Streamable HTTP/SSE MCP server or translates the tool invocation into an ordinary HTTP request.
7. Every available app gets a Wegent-managed local Skill. The Skill only identifies the app tool namespace, such as `crm__`; it contains neither administrator-provided prose nor credentials.

Tools are exposed as `<app_slug>__<upstream_tool_name>`. The same allowlist is enforced during both tool discovery and invocation, so a caller cannot bypass policy by constructing a tool name directly.

## HTTP API adapter

When the connection protocol is `HTTP API`, the endpoint is an API base URL. Each `http_tools` entry defines:

- `name` and `description`: the tool identity and model-facing purpose.
- `method` and `path`: `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` are supported. The path must be an absolute-path reference on the configured host; it cannot contain another origin, a query string, or a fragment.
- `input_schema`: a standard object JSON Schema. Runtime validates every invocation before sending the request.
- `argument_locations`: maps arguments to `path`, `query`, or JSON `body`. Unmapped GET/DELETE arguments become query parameters; arguments for other methods become JSON body fields. Path values are URL encoded.
- `timeout_seconds`: a per-request timeout between 1 and 120 seconds.

Backend does not follow redirects, preventing fixed headers from crossing to another host, and limits responses to 1 MB. JSON responses become both MCP text and structured content; non-2xx responses become MCP tool errors. Fixed provider headers, role visibility, and tool allowlists use the same policy as MCP upstreams.

## Authentication boundary

Connector currently supports this app authentication mode:

| Type | Use case | Credential location |
| --- | --- | --- |
| `none` | The upstream needs no per-user authorization, or identity is managed centrally by administrators | No user credential; optional administrator fixed headers |

Administrators can configure encrypted fixed headers, such as an internal API key or service token, without requiring every user to connect separately. Fixed provider headers are never returned by the administrator API. It only reports whether headers exist and the configured header names. The current version does not provide `bearer` or `oauth2` user authorization entry points and no longer stores per-user connector tokens.

## Deployment configuration

Production deployments must protect the shared sensitive-data encryption settings `GIT_TOKEN_AES_KEY` and `GIT_TOKEN_AES_IV`. Connector Apps use the existing `encrypt_sensitive_data` mechanism to store fixed headers in `Kind.json.spec.providerHeadersEncrypted`. Inject keys through a secret manager and never commit them. Plan a migration for existing encrypted fields before rotating keys.

```bash
GIT_TOKEN_AES_KEY="$(openssl rand -base64 24 | head -c 32)"
GIT_TOKEN_AES_IV="$(openssl rand -base64 12 | head -c 16)"
```

The current version has no Connector OAuth callback and does not require a third-party authorization callback URL. Production deployments should use HTTPS. Internal MCP endpoints may use HTTP, but only trusted administrators can configure them and egress should be constrained by network policy.

## Data and lifecycle

- Connector App definitions are stored in the `kinds` table with `kind = "ConnectorApp"`, `namespace = "system"`, and `metadata.name` matching the app `slug`.
- Apps can target MCP upstreams or HTTP API upstreams; the main configuration lives under `Kind.json.spec`.
- Administrator fixed headers are encrypted into `Kind.json.spec.providerHeadersEncrypted`.
- The current implementation does not introduce separate `connector_apps`, `connector_connections`, or `connector_oauth_sessions` tables, and it has no user connection records or OAuth temporary sessions.
- Disabling an app immediately removes it from user catalogs and Runtime.
- Administrators can replace or explicitly clear fixed provider headers; leaving the editor blank preserves the encrypted value.
- Wework removes generated local Skills for unavailable or disabled apps during the next synchronization.
- The Connector JWT is written only to a mode-`0600` runtime file in Executor's private directory and never to Codex configuration. The child process reads it again for each request, and an expired token cannot be used.
- Disconnecting Wework from cloud deletes the runtime token file and removes the `wegent_apps` MCP configuration and generated Skills, while local Codex workflows remain available.

## API layers

The paths below use the default `API_PREFIX=/api`; replace `/api` with your deployment's configured API prefix when it differs.

- `/api/admin/connector-apps`: administrator catalog CRUD.
- `/api/connector-apps`: current-user visible catalog. The `connection` field in the response is a frontend-compatibility projection and does not map to a `connector_connections` row.
- `/api/apps/list`, `/api/apps/read`, `/api/apps/installed`: Wework/Codex app projections.
- `/api/connector-runtime/token`: exchanges a normal cloud session for a least-privilege short token.
- `/api/connector-runtime/tools` and `/call`: accept only connector JWTs and are used by the Executor MCP proxy.

This design does not use Codex's native `codex_apps` server. Its ChatGPT authentication and remote app catalog belong to Codex itself. Wegent normalizes both MCP and HTTP upstreams into standard MCP at the Executor boundary, so Codex neither needs to be modified nor logged in.
