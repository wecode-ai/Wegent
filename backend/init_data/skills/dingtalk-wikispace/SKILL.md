---
description: "Read and manage DingTalk knowledge bases through the DingTalk Wikispace MCP. Use this skill when the user explicitly refers to a DingTalk knowledge base, space, page, or wiki."
displayName: "钉钉知识库"
version: "1.0.0"
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

Use the DingTalk Wikispace MCP for the knowledge base explicitly identified by the user.

- Read only the requested knowledge base, subtree, or page.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep knowledge-base page IDs separate from document and AI Table IDs when multiple DingTalk services are active.
- DingTalk remains the authority for the current user's permissions.
