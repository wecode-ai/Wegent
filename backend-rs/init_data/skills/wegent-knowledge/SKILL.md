---
description: "Knowledge base management and search tools for Wegent. Provides capabilities to list, create, update, and search knowledge bases and documents using RAG retrieval. Use this skill when the user wants to manage knowledge bases, documents, import DingTalk documents into a knowledge base, or search for information programmatically."
displayName: "知识库工具"
version: "1.2.0"
author: "Wegent Team"
tags: ["knowledge", "knowledge-base", "document", "rag"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  wegent-knowledge:
    type: streamable-http
    # NOTE: MCP client only supports ${{...}} variable substitution.
    # The platform will inject `backend_url` via task_data.
    url: "${{backend_url}}/mcp/knowledge/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Wegent Knowledge Base Skill

You now have access to Wegent Knowledge Base management tools.

## Available Tools

- **wegent_kb_list_knowledge_bases**: List all knowledge bases accessible to the current user
  - scope: "personal" (your own), "group" (team), "organization", or "all" (default)
  - group_name: Specify group name when scope="group"
  - limit: Maximum number of knowledge bases to return per page
  - offset: Start offset for paginated listing
  - returns: items, total, returned_count, limit, offset, has_more
  - each item includes namespace_level ("personal", "group", or "organization") and namespace_display_name ("personal", group display name, or organization display name)

- **wegent_kb_list_documents**: List all documents in a knowledge base
  - knowledge_base_id: ID of the knowledge base
  - folder_id: Optional selected folder ID
  - include_subfolders: Whether to include descendant folders (default: true)
  - limit: Maximum number of documents to return per page
  - offset: Start offset for paginated listing
  - returns: items, total, returned_count, limit, offset, has_more

- **wegent_kb_create_knowledge_base**: Create a new knowledge base
  - name: Knowledge base display name
  - description: Optional description
  - namespace: "default" (personal) or a group namespace (requires Maintainer+)
  - kb_type: "notebook" (default) or "classic"
  - summary_enabled: Enable automatic summary generation (default: true)

- **wegent_kb_create_document**: Create a new document in a knowledge base
  - knowledge_base_id: Target knowledge base ID
  - name: Document name
  - source_type: "text" (paste content), "file" (base64 encoded), or "web" (URL to scrape)
  - content: Document content when source_type="text"
  - file_base64: Base64 encoded file when source_type="file"
  - file_extension: File extension when source_type="file"
  - url: URL to fetch when source_type="web"
  - trigger_indexing: Whether to trigger RAG indexing (default: true)
  - trigger_summary: Whether to trigger summary generation (default: true)

- **wegent_kb_import_dingtalk_document**：将钉钉节点导入知识库或刷新已有副本
  - knowledge_base_id：目标知识库 ID
  - node_id：钉钉节点 ID
  - folder_id：新文档的文件夹 ID，默认 0（根目录）；已有副本保留原位置
  - 返回：id、name、index_status、action（created / refreshed / processing）、dingtalk_auto_sync_enabled（知识库当前配置）

- **wegent_kb_read_document_content**: Read raw document content with offset/limit pagination
  - document_id: Document ID to read
  - offset: Character offset to start reading from (default: 0)
  - limit: Maximum number of characters to return (uses the backend default when omitted)
  - returns: content slice, total_length, returned_length, has_more, kb_id

- **wegent_kb_update_document_content**: Update a document's content for text documents and editable plain-text files
  - document_id: Document ID to update
  - content: New content (replaces existing content)
  - trigger_reindex: Whether to trigger RAG re-indexing (default: true)

- **wegent_kb_search_knowledge_base**: Search documents using RAG retrieval
  - knowledge_base_id: Knowledge base ID to search
  - query: Search query text
  - search_hints: Optional query plan. Only use `semantic_query` (string), `keywords` (array of terms), and `phrases` (array of exact multi-word matches). Never use `exact_keywords`.
  - max_results: Maximum results to return (default: 10, max: 50)
  - document_ids: Optional list of document IDs to filter search scope
  - folder_ids: Optional list of selected folder IDs
  - include_subfolders: Whether folder IDs include descendants

## Usage Notes

- All operations inherit the current user's permissions
- For a folder in `<selected_knowledge_sources>`, pass its original ID through `folder_id`/`folder_ids` and set `include_subfolders=true`. A selected folder always includes its entire descendant subtree. Never broaden the request to the whole knowledge base to discover descendants.
- For a selected document, pass its original ID through `document_ids` instead of broadening to the whole knowledge base.
- After creating or updating documents, indexing happens asynchronously
- Documents may show status "pending" until indexing completes
- For web scraping, the URL content is fetched and stored as document content
- `wegent_kb_update_document_content` supports `text` documents and plain-text file documents such as `txt`, `md`, and `markdown`; binary files like `pdf` or `docx` still require creating or replacing the source file instead of inline editing
- Avoid loops: if a tool call fails, report the error once and stop retrying/re-loading the skill unless the user changes inputs.
- Long documents should be read incrementally: start with the backend default limit, then continue with `offset = previous_offset + previous_returned_length` while `has_more=true`

## 导入钉钉文档

用户要求将钉钉文档导入知识库时，调用 `wegent_kb_import_dingtalk_document`。

1. 根据链接格式提取单个节点 ID，忽略 `#` 后的片段：
   - `https://alidocs.dingtalk.com/i/nodes/{nodeId}` 或 `https://docs.dingtalk.com/i/nodes/{nodeId}`：提取 `/i/nodes/` 后的节点 ID，忽略 query 参数。例如 `https://alidocs.dingtalk.com/i/nodes/abc123?from=chat` 提取 `abc123`。
   - `https://alidocs.dingtalk.com/uni-preview?...&dentryUuid={nodeId}&...`：读取 query 参数 `dentryUuid` 的值作为 `node_id`。例如 `https://alidocs.dingtalk.com/uni-preview?extension=docx&fileId=123&dentryUuid=abc123` 提取 `abc123`；`fileId`、`cloudSpaceDentryId` 和空间 ID 均不是此处要传的节点 ID。
   无法提取非空节点 ID 时，请用户提供有效的文档链接。节点是否存在、能否访问及实际文档类型，以导入工具的实时 MCP 查询结果为准，链接中的 `extension` 不作为类型校验依据。
2. 从当前上下文确定目标知识库和文件夹，必要时通过现有列表工具定位；只有无法确定目标时才询问用户。省略 `folder_id` 或传 `0` 表示根目录。
3. 直接传入节点 ID，无需同步钉钉目录、抓取网页或读取并重传正文。服务端会使用钉钉 MCP 获取实时标题和文档类型。

   ```text
   wegent_kb_import_dingtalk_document(
     knowledge_base_id=123,
     node_id="abc123",
     folder_id=0
   )
   ```

返回字段包括 `id`、`name`、`index_status`、`dingtalk_auto_sync_enabled` 和 `action`：

- `created`：已创建副本，处理结果以 `index_status` 为准，不代表已可检索。
- `refreshed`：已请求原文档刷新，保留文档 ID、目录位置和原导入者授权；处理结果以 `index_status` 为准。
- `processing`：原文档正在处理，等待完成，不连续重复提交。

自动同步由知识库已有配置决定，本工具保持其配置不变。`dingtalk_auto_sync_enabled=true` 表示已配置参与每日同步，不代表同步已经执行成功。后续刷新沿用原导入者的授权。

失败时依据实际错误提示用户处理知识库权限、文档访问权或钉钉服务配置与授权；在线表格需要 Table MCP，AI 表格需要 AI Table MCP。受理后的后台失败通过文档状态查看；原导入者授权失效时，由原导入者恢复授权后再重试。

## Example Workflow

1. List documents in a specific knowledge base:
   ```
   wegent_kb_list_documents(knowledge_base_id=123, limit=20, offset=0)
   ```

   If `has_more=true`, continue with:
   ```
   wegent_kb_list_documents(knowledge_base_id=123, limit=20, offset=20)
   ```

2. Create a new knowledge base:
   ```
   wegent_kb_create_knowledge_base(
     name="My KB",
     description="My personal notes",
     namespace="default",
     kb_type="notebook"
   )
   ```

3. Create a new text document:
   ```
   wegent_kb_create_document(
     knowledge_base_id=123,
     name="Meeting Notes",
     source_type="text",
     content="Notes from today's meeting..."
   )
   ```

4. Update document content:
   ```text
   wegent_kb_update_document_content(
     document_id=456,
     content="Updated notes with new information...",
     trigger_reindex=true
   )
   ```

5. Read long document content incrementally:
   ```text
   wegent_kb_read_document_content(
     document_id=456,
     offset=0
   )
   ```

6. Search knowledge base using RAG retrieval:
   ```text
   wegent_kb_search_knowledge_base(
     knowledge_base_id=123,
     query="How to configure the system?",
     max_results=10
   )
   ```

7. Search within specific documents:
   ```text
   wegent_kb_search_knowledge_base(
     knowledge_base_id=123,
     query="deployment steps",
     max_results=5,
     document_ids=[456, 789]
   )
   ```
