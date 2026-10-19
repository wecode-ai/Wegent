---
description: "Read and manage DingTalk spreadsheets through the DingTalk Table MCP. Use this skill when the user explicitly refers to a DingTalk spreadsheet, worksheet, cell, or formula."
displayName: "钉钉表格"
version: "1.0.0"
author: "Wegent Team"
tags: ["dingtalk", "table", "spreadsheet"]
bindShells:
  - Chat
  - ClaudeCode
mcpServers:
  dingtalk_table:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.table.credentials.url}}"
---

# DingTalk Tables

Use the DingTalk Table MCP for the spreadsheet explicitly identified by the user.

- Read only the requested workbook, worksheet, cells, and formulas.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep spreadsheet IDs separate from DingTalk AI Table IDs when both services are active.
- DingTalk remains the authority for the current user's permissions.
