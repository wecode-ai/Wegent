---
description: "Read and manage DingTalk knowledge bases through the DingTalk Wikispace MCP. Use this skill when the user explicitly refers to a DingTalk knowledge base, space, page, or wiki."
displayName: "钉钉知识库"
version: "1.2.0"
author: "Wegent Team"
tags: ["dingtalk", "wikispace", "knowledge"]
bindShells:
  - Chat
  - ClaudeCode
mcpServers:
  dingtalk_wikispace:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.wikispace.credentials.url}}"
---

# DingTalk Wikispaces

DingTalk knowledge bases are reachable through either a personal Streamable HTTP MCP the user already configured (`dingtalk_wikispace` server) or the shared `wegent-connectors` MCP server. Use whichever tools this session exposes and never request credentials. If a tool reports that the connector requires authorization, tell the user briefly and end the turn with `connector_auth_required` and `connectorSlug=dingtalk_wiki`.

Operate only on the knowledge base explicitly identified by the user.

- Read only the requested knowledge base, subtree, or page.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep knowledge-base page IDs separate from document and AI Table IDs when multiple DingTalk services are active.
- DingTalk remains the authority for the current user's permissions.
