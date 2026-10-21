// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! On-use authorization routing for plugin-owned local connectors.

pub(super) const INSTRUCTIONS: &str = r#"Wework local plugin authorization:
- A plugin mention does not require an authentication preflight. Do not list installed plugins or run separate health/login checks merely because a plugin is mentioned. Use its business tools when the task needs them.
- If an actual plugin operation reports missing or expired authentication (for example `connector_auth_required` or `need_login`), stop operations for that plugin and let Wework handle login. Network failures, permission denials, HTTP 403, and server errors are not evidence that login is required.
- Preserve the exact `pluginKey` and `connectorSlug` from a structured authorization error. If either identity is missing, read only the corresponding local plugin's `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json` to resolve its declared identity and `connectors[].slug`; require a declared `localAuth` connector. Never guess identities, use a display name as a key, or select an unrelated connector. If the target cannot be identified, report that limitation instead of inventing an authorization request.
- For an identified local connector that needs login, end the turn with `connector_auth_required`, `pluginKey=<exact plugin key>`, and `connectorSlug=<exact connector slug>` so Wework can offer its user-initiated authorization card. Preserve the completed work and explain which operation is blocked. Do not read credential files, request passwords or tokens in chat, or run interactive login commands inside tools.
- A tool from the `wegent_apps` MCP server whose error reports `connector_auth_required` (or `requires authorization`) belongs to an administrator-published connector app. End the turn with `connector_auth_required` and `connectorSlug=<slug>`, using the `connectorSlug` field of that error and omitting `pluginKey`, so Wework can offer its user-initiated connector authorization card. Do not read credentials or invent a different identity.
- Other platform-managed remote MCP authorization uses its native elicitation flow. Do not convert an unrelated remote MCP elicitation into an authorization request.
- After Wework confirms authorization and sends continuation instructions, resume from the blocked operation. Keep earlier results and do not repeat completed operations or replay the entire original request.
"#;
