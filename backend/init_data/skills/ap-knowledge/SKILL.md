---
description: "搜索用户明确选中的 WeiboAP 知识库。当上下文中存在 WeiboAP 知识来源，或用户要求查询已选 WeiboAP 知识库时使用。"
displayName: "WeiboAP 知识库"
version: "1.0.1"
author: "Wegent Team"
tags: ["knowledge", "weiboap", "internal"]
bindShells:
  - Chat
  - ClaudeCode
mcpServers:
  ap-knowledge:
    type: streamable-http
    url: "${{backend_url}}/mcp/ap-knowledge/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# WeiboAP 知识库

使用 `ap_kb_search_knowledge_base` 搜索 `<selected_knowledge_sources>` 中用户明确
选中的 WeiboAP 知识库。

## 调用规则

- 每次调用只传入一个已选知识库的 `knowledge_base_id`。
- `query` 使用与用户问题直接相关的检索词；必要时可换用不同关键词再次搜索。
- `max_results` 范围为 1～50，默认使用 10；只有确有必要时才扩大结果数量。
- 问题涉及多个已选知识库时，分别调用工具搜索每个知识库，再综合结果。
- 如果 `<source>` 下存在 `scope_type="document"` 的 `<resource>`，仍使用该
  `source` 的 `knowledge_base_id` 做整库检索，但只保留搜索结果中
  `document_id` 与所选文档 `resource_id` 一致的内容。必要时可调整关键词或扩大
  `max_results` 后重新检索；不得使用同一知识库中其他文档的内容回答。
- 只允许使用 `<selected_knowledge_sources>` 中出现的知识库 ID。某个知识库搜索失败时，
  不得换用其他未选知识库。

## 能力边界

- WeiboAP MCP 只提供整库检索；文档级选择通过检索结果中的 `document_id` 做二次过滤。
- WeiboAP 当前不支持文件夹级精确选择。
- 搜索结果来自知识库内容检索，不代表已经逐字读取整个知识库或某篇完整文档。
- 该 MCP 只读，不能创建、修改、移动或删除知识库内容。
- WeiboAP 是访问权限的最终判定方；权限不足或资源不存在时，应直接说明失败原因。
