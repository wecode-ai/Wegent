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

使用 `ks_kb_list_nodes` 浏览、定位 `<selected_knowledge_sources>` 中用户明确选中的
WeiboAP 知识库节点，使用 `ap_kb_search_knowledge_base` 搜索其中的内容。

## 调用规则

- 调用 `ks_kb_list_nodes` 时，每次只传入一个已选知识库的
  `knowledge_base_id`；不得枚举未选择的知识库。
- 从根目录开始浏览时省略 `folder_id`；继续浏览文件夹时传入文件夹节点的
  `raw_id`，不要传带类型前缀的 `node_id`。仅在确需完整目录树时设置
  `recursive=true`。
- `ks_kb_list_nodes` 的 `limit` 范围为 1～500，默认 100；使用 `offset` 继续分页。
- 每次调用只传入一个已选知识库的 `knowledge_base_id`。
- `query` 使用与用户问题直接相关的检索词；必要时可换用不同关键词再次搜索。
- `max_results` 范围为 1～50，默认使用 10；只有确有必要时才扩大结果数量。
- 问题涉及多个已选知识库时，分别调用工具搜索每个知识库，再综合结果。
- 只允许使用 `<selected_knowledge_sources>` 中出现的知识库 ID。某个知识库搜索失败时，
  不得换用其他未选知识库。

## 能力边界

- WeiboAP 只支持按知识库整体选择；节点浏览用于理解已选知识库结构，不会把文件夹或
  文档升级为新的已选范围。
- 搜索结果来自知识库内容检索，不代表已经逐字读取整个知识库或某篇完整文档。
- 该 MCP 只读，不能创建、修改、移动或删除知识库内容。
- WeiboAP 是访问权限的最终判定方；权限不足或资源不存在时，应直接说明失败原因。
