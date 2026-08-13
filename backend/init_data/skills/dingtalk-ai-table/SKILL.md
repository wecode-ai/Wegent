---
description: "Read and manage DingTalk AI table records through the DingTalk AI Table MCP. Use this skill when the user explicitly refers to a DingTalk AI table, fields, or records."
displayName: "钉钉 AI 表格"
version: "1.0.0"
author: "Wegent Team"
tags: ["dingtalk", "ai-table", "records"]
bindShells:
  - Chat
  - ClaudeCode
mcpServers:
  dingtalk_ai_table:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.ai_table.credentials.url}}"
---

# DingTalk AI Tables

Use the DingTalk AI Table MCP for the table explicitly identified by the user.

- Read only the requested table, view, fields, and records.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep document node IDs and AI table IDs separate when both DingTalk services are active.
- DingTalk remains the authority for the current user's permissions.
