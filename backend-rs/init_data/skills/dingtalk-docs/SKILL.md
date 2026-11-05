---
description: "Access DingTalk documents and knowledge spaces through the DingTalk document MCP. Use this skill whenever the user selects a DingTalk knowledge space, folder, or document."
displayName: "钉钉文档"
version: "1.0.1"
author: "Wegent Team"
tags: ["knowledge", "dingtalk", "document"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
config:
  unconfiguredGuide:
    modalLink: "wegent://modal/mcp-provider-config?provider=dingtalk&service=docs"
    modalText: "打开钉钉文档 MCP 配置弹窗"
mcpServers:
  dingtalk_docs:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.docs.credentials.url}}"
---

# DingTalk Documents

If this session has no configured DingTalk document MCP, ask the user to [打开钉钉文档 MCP 配置弹窗](wegent://modal/mcp-provider-config?provider=dingtalk&service=docs). Do not try to access DingTalk documents until configuration is complete.

When configured, use the DingTalk document MCP directly. Resource IDs in `<selected_knowledge_sources>` are DingTalk-native IDs.

- For a knowledge space, call `list_nodes` with its workspace ID and traverse the returned hierarchy.
- For a folder, call `list_nodes` with the selected folder ID and continue through descendants when needed.
- For a document, call `get_document_content` with the selected node ID to read its Markdown body.
- `search_documents` does not guarantee workspace or folder scoping. Do not use an unscoped search when the user selected a narrower range; traverse the hierarchy or read the exact document instead.
- The MCP exposes both read and write capabilities. A selected source is a routing hint, not write authorization; DingTalk remains the authority for permissions.
