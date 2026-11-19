---
sidebar_position: 4
---

# App Connections

Connector Apps let administrators publish MCP services or HTTP APIs for Wegent agents. For OAuth apps, users authorize through Wegent Web **Settings → Integrations**, Wework connection settings, or an in-conversation authorization card. Wework synchronizes these capabilities into local Codex after connecting to Wegent Cloud.

## Administrator Setup

1. Open **System Administration → App Connections** in Wegent Web.
2. Create an app with a unique `slug`, name, description, and icon. Runtime tools are exposed as `<slug>__<tool>`.
3. Choose a connection protocol:
   - **MCP**: enter a Streamable HTTP or SSE endpoint.
   - **HTTP API**: enter the API base URL and define each tool with method, path, JSON Schema, and argument locations.
4. Choose the authentication method: **None** for systems without per-user authorization, optionally with administrator-managed fixed headers; **OAuth 2.0** for standard MCP OAuth user authorization, with an optional scope.
5. Set visibility and the tool allowlist. The allowlist limits both tool discovery and tool calls.
6. Choose lazy (`lazy`) or static (`static`) loading and configure conversation keywords. Save the app, then use tool discovery or the test action to verify it; OAuth apps must be authorized first.

Fixed headers are never returned in plaintext by the administrator API or UI. Leaving the editor blank preserves the encrypted fixed headers; administrators can also explicitly clear and replace them.

## User Visibility

Backend returns apps according to administrator visibility policy. OAuth grants belong to the current user and are never shared with other users:

- `visibility: all` apps are visible to all signed-in users.
- `visibility: roles` apps are visible only to roles listed in `allowed_roles`.
- Disabled apps disappear from user catalogs and runtime tool lists.
- Changing an app's MCP URL or authentication type removes its old connections and requires fresh authorization.

## Using Apps In Wework

After Wework connects to Wegent Cloud, it synchronizes Connector Apps that are visible and callable for the current user:

- Executor registers the local MCP server `wegent_apps`.
- Each app gets a Wegent-managed local Skill.
- Codex only receives tool names and schemas. It never sees administrator-managed fixed headers.
- Connect unauthorized apps through the authorization card or connection settings; the interrupted step continues after local capability synchronization completes.
- Expired connections can refresh automatically; explicitly revoked grants require reconnection. Temporary upstream failures or credential-decryption configuration faults are not treated as missing authorization.

When the cloud connection is removed, Wework removes the connector short credential, the `wegent_apps` MCP configuration, and generated Connector Skills.

## Data And Deployment Notes

Connector App definitions are stored in the `kinds` table with `kind = "ConnectorApp"` and `namespace = "system"`. Administrator fixed headers are encrypted into `Kind.json.spec.providerHeadersEncrypted`.

Production deployments must protect `GIT_TOKEN_AES_KEY` and `GIT_TOKEN_AES_IV` and configure `CONNECTOR_OAUTH_REDIRECT_URI` for OAuth. Fixed headers and user tokens use the existing sensitive-data encryption mechanism.

Built-in DingTalk docs, sheets, AI tables, and wiki are enabled with lazy loading by default. Deleting an app physically removes its definition and every user connection; built-in apps are restored at the next backend startup, while administrator-disabled apps remain disabled.

For architecture, database tables, and security boundaries, see [Connector Apps Architecture and Deployment](../../developer-guide/connector-apps.md).
