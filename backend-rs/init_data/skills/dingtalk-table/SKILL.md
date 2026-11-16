---
description: "Read and manage DingTalk spreadsheets through the DingTalk Table MCP. Use this skill when the user explicitly refers to a DingTalk spreadsheet, worksheet, cell, or formula."
displayName: "钉钉表格"
version: "1.0.1"
author: "Wegent Team"
tags: ["dingtalk", "table", "spreadsheet"]
bindShells:
  - Chat
  - ClaudeCode
config:
  unconfiguredGuide:
    modalLink: "wegent://modal/mcp-provider-config?provider=dingtalk&service=table"
    modalText: "打开钉钉表格 MCP 配置弹窗"
mcpServers:
  dingtalk_table:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.table.credentials.url}}"
---

# DingTalk Tables

If this session has no configured DingTalk Table MCP, ask the user to [打开钉钉表格 MCP 配置弹窗](wegent://modal/mcp-provider-config?provider=dingtalk&service=table). Do not try to access DingTalk spreadsheets until configuration is complete.

When configured, use the DingTalk Table MCP for the spreadsheet explicitly identified by the user.

- Read only the requested workbook, worksheet, cells, and formulas.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep spreadsheet IDs separate from DingTalk AI Table IDs when both services are active.
- DingTalk remains the authority for the current user's permissions.
