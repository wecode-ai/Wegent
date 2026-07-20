---
sidebar_position: 19
---

# Connector Apps Architecture and Deployment

Connector Apps let Wework connect to internal systems without changing Codex source code or requiring a ChatGPT login. Responsibilities are separated: Wegent Admin manages definitions and authentication policy, Wegent Backend stores encrypted credentials and proxies upstream MCP servers, and Executor exposes a local MCP endpoint to Codex. Wework has no Connector settings page; it only synchronizes available capabilities after connecting to Wegent Cloud.

## Runtime flow

1. An administrator configures the remote MCP URL, authentication, role visibility, and tool allowlist under **System Administration → App Connections**.
2. For an administrator-managed internal system, selecting `none` authentication and configuring encrypted fixed headers makes the app available automatically to allowed roles. Bearer or OAuth apps that require user identity must be authorized through Wegent Web/API first; Wework does not host configuration or authorization UI.
3. After a user connects Wework to Wegent Cloud, Wework automatically synchronizes Connector Apps and Skills available to that user.
4. Wework exchanges its cloud session for a 15-minute connector JWT. This token only has the `connectors:invoke` scope and cannot replace a user login token.
5. Executor registers itself as the ordinary stdio MCP server `wegent_apps`. Codex connects only to this local process and never receives OAuth tokens, bearer tokens, or fixed provider headers.
6. The `wegent_apps` child process reads the automatically rotated short token from Executor's private directory and calls Wegent Connector Runtime. Backend decrypts credentials and connects to the upstream Streamable HTTP or SSE MCP server on the user's behalf.
7. Every available app gets a Wegent-managed local Skill. The Skill only identifies the app tool namespace, such as `crm__`; it contains neither administrator-provided prose nor credentials.

Tools are exposed as `<app_slug>__<upstream_tool_name>`. The same allowlist is enforced during both tool discovery and invocation, so a caller cannot bypass policy by constructing a tool name directly.

## Authentication boundary

| Type | Use case | Credential location |
| --- | --- | --- |
| `none` | The upstream needs no user identity | No user credential |
| `bearer` | The user provides a personal access token | Encrypted in Wegent Backend |
| `oauth2` | OAuth 2.0 Authorization Code with PKCE | Encrypted access and refresh tokens in Wegent Backend |

OAuth token endpoints can use `client_secret_post`, `client_secret_basic`, or the public-client method `none`. The confidential-client methods require a client secret; public clients do not store one. Only a SHA-256 digest of OAuth state is stored. The PKCE verifier, client secret, user tokens, and fixed headers are encrypted with `USER_AES_KEY` using AES-256-CBC and an independent random IV per ciphertext. State is single-use; failed or expired authorization must be restarted.

`none` also supports administrator-managed identity for internal systems: an administrator can configure encrypted fixed headers, such as an internal API key, without requiring every user to connect separately. Fixed provider headers and OAuth client secrets are never returned by the administrator API. It only reports whether a secret exists and the configured header names.

## Deployment configuration

Production deployments must provide a dedicated 32-byte `USER_AES_KEY`; a Base64-encoded key with the `base64:` prefix is also supported. Inject it through a secret manager and never commit it. Plan to reauthorize or migrate existing Connector credentials before rotating the key.

```bash
USER_AES_KEY="base64:$(openssl rand -base64 32)"
```

When Backend is behind a reverse proxy and cannot derive the public callback origin from the request, set:

```bash
CONNECTOR_OAUTH_CALLBACK_BASE_URL=https://wegent.example.com
```

The resulting callback is:

```text
https://wegent.example.com/api/connector-apps/oauth/callback
```

Register this exact URL with the OAuth provider. Production deployments should use HTTPS. Internal MCP endpoints may use HTTP, but only trusted administrators can configure them and egress should be constrained by network policy.

## Data and lifecycle

- `connector_apps` stores administrator-published definitions.
- `connector_connections` stores per-user connections and encrypted credentials.
- `connector_oauth_sessions` stores short-lived, single-use OAuth state and PKCE sessions.
- Disabling an app immediately removes it from user catalogs and Runtime and deletes existing user connections; users must authorize it again after re-enabling.
- Changing the MCP URL, authentication type, or OAuth client configuration deletes existing user connections so old credentials cannot cross into a new security boundary.
- Administrators can replace or explicitly clear fixed provider headers; leaving the editor blank preserves the encrypted value.
- Deleting a user connection makes Wework remove the generated local Skill during the next synchronization; `none` apps do not depend on user connection records.
- Deleting a Wegent connection does not automatically call a provider-specific token revocation endpoint. To revoke the grant completely, the user should also revoke it from the provider's account security page.
- The Connector JWT is written only to a mode-`0600` runtime file in Executor's private directory and never to Codex configuration. The child process reads it again for each request, and an expired token cannot be used.
- Disconnecting Wework from cloud deletes the runtime token file and removes the `wegent_apps` MCP configuration and generated Skills, while local Codex workflows remain available.

## API layers

- `/api/admin/connector-apps`: administrator catalog CRUD.
- `/api/connector-apps`: current-user catalog, authorization, and disconnect operations.
- `/api/connector-runtime/token`: exchanges a normal cloud session for a least-privilege short token.
- `/api/connector-runtime/tools` and `/call`: accept only connector JWTs and are used by the Executor MCP proxy.

This design does not use Codex's native `codex_apps` server. Its ChatGPT authentication and remote app catalog belong to Codex itself. Wegent enters the Codex flow through standard MCP configuration, so Codex neither needs to be modified nor logged in.
