---
description: "Query the built-in Wegent Help knowledge base through a single read-only MCP tool. Use this skill only when Wegent Help needs documentation retrieval."
displayName: "Wegent 帮助知识库查询"
version: "1.0.0"
author: "Wegent Team"
tags: ["wegent", "help", "docs", "rag"]
bindShells:
  - Chat
  - ClaudeCode
preload: false
mcpServers:
  wegent-help-knowledge:
    type: streamable-http
    # NOTE: MCP client only supports ${{...}} variable substitution.
    # The platform will inject `backend_url` via task_data.
    url: "${{backend_url}}/mcp/help-knowledge/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Wegent Help Knowledge Query

Use this skill to search the built-in Wegent Help knowledge base.

## Tool

- `wegent_help_query`: Search Wegent Help with RAG retrieval.
  - `query`: The user's full Wegent question.
  - `max_results`: Optional result limit. Use `8` unless the user needs more detail.

## Rules

1. Pass the user's full question to `wegent_help_query`.
2. Base the answer on returned chunks before using general model memory.
3. Include source document names or source references from the response.
4. If the tool returns an error or no chunks, say the built-in help content is unavailable or not indexed yet.
5. Keep the answer in the same language as the user's question whenever possible.
