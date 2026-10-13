---
sidebar_position: 5
---

# OAuth authorization for provider MCP servers

Some providers, such as DingTalk, offer two ways to connect to their MCP servers:

- **Personal StreamableHttp URL**: the URL embeds a personal credential that expires within 30 days, so it must be copied again from the provider page afterwards.
- **OAuth 2.0 authorization**: the provider exposes an OAuth URL; after a single authorization the client keeps refreshing tokens, so the personal URL expiry no longer applies.

Wegent supports the second option and performs the authorization and refresh on the user's behalf.

## Switch to OAuth 2.0

1. Open **Settings → Integrations** and find the target provider service card (for example DingTalk).
2. Turn the **Enabled** switch on.
3. Choose **OAuth 2.0 authorization** under **Authentication**.
4. Paste the OAuth URL shown on the provider page, for example `https://mcp-gw.dingtalk.com/oauth/server/aitable`.
5. Save, then click **Connect and authorize** and finish the authorization in the opened page.
6. When authorization completes, the card shows **Connected**. Use **Disconnect** whenever you need to authorize again.

DingTalk documents, spreadsheets, AI tables and knowledge bases are four separate service URLs and must be configured individually.

## Behavior

- Wegent discovers the provider's protected-resource and authorization-server metadata from the OAuth URL, registers a public client, and authorizes with the authorization code flow plus PKCE.
- Access and refresh tokens are stored encrypted per user, and an access token that is about to expire is refreshed before a task starts, so the URL no longer needs to be replaced every 30 days.
- Provider Skills used by tasks (for example DingTalk documents and DingTalk AI tables) and the knowledge-base sync all use the same authorization.
- The personal StreamableHttp URL mode is unchanged; switching back to it clears the stored OAuth credentials.
- If the refresh token expires or is revoked, reconnect and authorize again from the integrations page.
