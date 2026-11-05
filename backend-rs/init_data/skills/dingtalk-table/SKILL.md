---
description: "Read and manage DingTalk spreadsheets through the DingTalk Table MCP. Use this skill when the user explicitly refers to a DingTalk spreadsheet, worksheet, cell, or formula."
displayName: "钉钉表格"
version: "1.2.0"
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

DingTalk spreadsheets are reachable through either a personal Streamable HTTP MCP the user already configured (`dingtalk_table` server) or the shared `wegent-connectors` MCP server. Use whichever tools this session exposes and never request credentials. If a tool reports that the connector requires authorization, tell the user briefly and end the turn with `connector_auth_required` and `connectorSlug=dingtalk_sheet`.

Operate only on the spreadsheet explicitly identified by the user.

- Read only the requested workbook, worksheet, cells, and formulas.
- Use create, update, or delete tools only when the user explicitly requests that mutation.
- Keep spreadsheet IDs separate from DingTalk AI Table IDs when both services are active.
- DingTalk remains the authority for the current user's permissions.
