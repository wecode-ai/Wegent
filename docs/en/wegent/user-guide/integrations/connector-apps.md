---
sidebar_position: 4
---

# App Connections

Connector Apps let administrators publish internal MCP services or HTTP APIs for Wegent agents. Users only connect or authorize apps they can see. After Wework connects to Wegent Cloud, it synchronizes those capabilities into local Codex automatically.

## Administrator Setup

1. Open **System Administration → App Connections** in Wegent Web.
2. Create an app with a unique `slug`, name, description, and icon. Runtime tools are exposed as `<slug>__<tool>`.
3. Choose a connection protocol:
   - **MCP**: enter a Streamable HTTP or SSE endpoint.
   - **HTTP API**: enter the API base URL and define each tool with method, path, JSON Schema, and argument locations.
4. Choose an authentication method:
   - **None**: for systems that do not need per-user identity, optionally with administrator-managed fixed headers.
   - **Bearer**: each user submits a personal access token in Wegent.
   - **OAuth 2.0**: users authorize from Wegent, and Backend stores encrypted tokens.
5. Set visibility and the tool allowlist. The allowlist limits both tool discovery and tool calls.
6. Save the app, then use tool discovery or the test action to verify the configuration.

Fixed headers, OAuth client secrets, and user credentials are never returned in plaintext by the administrator API or UI. Changing the MCP URL, authentication type, or OAuth client configuration clears existing user connections, so users must authorize again.

## User Connection

Users connect apps from the visible app catalog:

- `none` apps are usually available automatically.
- `bearer` apps require the user's personal access token.
- `oauth2` apps open the third-party authorization page and then return to Wegent.

Disconnecting removes the saved Wegent connection only. It does not revoke the grant on the third-party provider. For full revocation, users should also remove the authorization from the provider's account security or authorized apps page.

## Using Apps In Wework

After Wework connects to Wegent Cloud, it synchronizes connected and callable Connector Apps:

- Executor registers the local MCP server `wegent_apps`.
- Each app gets a Wegent-managed local Skill.
- Codex only receives tool names and schemas. It never sees OAuth tokens, bearer tokens, or administrator fixed headers.

When the cloud connection is removed, Wework removes the connector short credential, the `wegent_apps` MCP configuration, and generated Connector Skills.

## Deployment Notes

Production deployments must set a dedicated `USER_AES_KEY` for Connector credential encryption. If Backend is behind a reverse proxy and the request Host is not the public origin reachable by OAuth providers, set `CONNECTOR_OAUTH_CALLBACK_BASE_URL` and register the resulting callback URL with the provider.

For architecture, database tables, and security boundaries, see [Connector Apps Architecture and Deployment](../../developer-guide/connector-apps.md).
