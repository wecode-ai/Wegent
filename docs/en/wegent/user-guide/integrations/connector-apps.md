---
sidebar_position: 4
---

# App Connections

Connector Apps let administrators publish internal MCP services or HTTP APIs for Wegent agents. The current version does not provide a user-facing third-party authorization flow; after administrators publish apps visible to a user, Wework synchronizes those capabilities into local Codex automatically when it connects to Wegent Cloud.

## Administrator Setup

1. Open **System Administration → App Connections** in Wegent Web.
2. Create an app with a unique `slug`, name, description, and icon. Runtime tools are exposed as `<slug>__<tool>`.
3. Choose a connection protocol:
   - **MCP**: enter a Streamable HTTP or SSE endpoint.
   - **HTTP API**: enter the API base URL and define each tool with method, path, JSON Schema, and argument locations.
4. Choose the authentication method. The current version supports **None** only: for systems that do not need per-user authorization, optionally with administrator-managed fixed headers such as an internal API key or service token.
5. Set visibility and the tool allowlist. The allowlist limits both tool discovery and tool calls.
6. Save the app, then use tool discovery or the test action to verify the configuration.

Fixed headers are never returned in plaintext by the administrator API or UI. Leaving the editor blank preserves the encrypted fixed headers; administrators can also explicitly clear and replace them.

## User Visibility

Users do not connect Connector Apps individually in Wegent. Backend returns the apps available to the current user according to administrator visibility policy:

- `visibility: all` apps are visible to all signed-in users.
- `visibility: roles` apps are visible only to roles listed in `allowed_roles`.
- Disabled apps disappear from user catalogs and runtime tool lists.

## Using Apps In Wework

After Wework connects to Wegent Cloud, it synchronizes Connector Apps that are visible and callable for the current user:

- Executor registers the local MCP server `wegent_apps`.
- Each app gets a Wegent-managed local Skill.
- Codex only receives tool names and schemas. It never sees administrator fixed headers.

When the cloud connection is removed, Wework removes the connector short credential, the `wegent_apps` MCP configuration, and generated Connector Skills.

## Data And Deployment Notes

Connector App definitions are stored in the `kinds` table with `kind = "ConnectorApp"` and `namespace = "system"`. Administrator fixed headers are encrypted into `Kind.json.spec.providerHeadersEncrypted`.

Production deployments must protect the shared sensitive-data encryption settings `GIT_TOKEN_AES_KEY` and `GIT_TOKEN_AES_IV`; Connector Apps use the existing `encrypt_sensitive_data` mechanism for fixed headers. The current version does not require an OAuth callback URL.

For architecture, database tables, and security boundaries, see [Connector Apps Architecture and Deployment](../../developer-guide/connector-apps.md).
