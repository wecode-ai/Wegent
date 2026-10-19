---
description: "Read and manage DingTalk AI table records through the DingTalk AI Table MCP. Use this skill when the user explicitly refers to a DingTalk AI table, fields, or records."
displayName: "钉钉 AI 表格"
version: "1.0.1"
author: "Wegent Team"
tags: ["dingtalk", "ai-table", "records"]
bindShells:
  - Chat
  - ClaudeCode
config:
  unconfiguredGuide:
    modalLink: "wegent://modal/mcp-provider-config?provider=dingtalk&service=ai_table"
    modalText: "打开钉钉AI表格 MCP 配置弹窗"
mcpServers:
  dingtalk_ai_table:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.ai_table.credentials.url}}"
---

# DingTalk AI Tables

If this session has no configured DingTalk AI Table MCP, ask the user to [打开钉钉AI表格 MCP 配置弹窗](wegent://modal/mcp-provider-config?provider=dingtalk&service=ai_table). Do not try to access DingTalk AI tables until configuration is complete.

When configured, use the DingTalk AI Table MCP for the table explicitly identified by the user.

- Read only the requested table, view, fields, and records.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep document node IDs and AI table IDs separate when both DingTalk services are active.
- DingTalk remains the authority for the current user's permissions.
