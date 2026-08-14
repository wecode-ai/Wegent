---
description: "Access DingTalk documents and knowledge spaces through the DingTalk document MCP. Use this skill whenever the user selects a DingTalk knowledge space, folder, or document."
displayName: "钉钉文档"
version: "1.0.0"
author: "Wegent Team"
tags: ["knowledge", "dingtalk", "document"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  dingtalk_docs:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.docs.credentials.url}}"
---

# DingTalk Documents

Use the DingTalk document MCP directly. Resource IDs in `<selected_knowledge_sources>` are DingTalk-native IDs.

- For a knowledge space, call `list_nodes` with its workspace ID and traverse the returned hierarchy.
- For a folder, call `list_nodes` with the selected folder ID and continue through descendants when needed.
- For a document, call `get_document_content` with the selected node ID to read its Markdown body.
- `search_documents` does not guarantee workspace or folder scoping. Do not use an unscoped search when the user selected a narrower range; traverse the hierarchy or read the exact document instead.
- The MCP is a provider capability surface, not a read-only projection. Use its create or update tools only when the user explicitly requests a mutation; the selected source is a routing hint, not write authorization.
- DingTalk is the authority for the current user's permissions.
