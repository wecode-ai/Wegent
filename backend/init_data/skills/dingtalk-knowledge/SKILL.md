---
description: "Upload DingTalk documents, spreadsheets, and AI tables to knowledge base. Supports extracting content from DingTalk URLs and creating knowledge base documents with proper source attribution."
displayName: "钉钉文档上传"
version: "1.0.0"
author: "Wegent Team"
tags: ["dingtalk", "knowledge", "document", "spreadsheet", "ai-table"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
provider:
  module: provider
  class: DingTalkKnowledgeProvider
config:
  unconfiguredGuide:
    modalLink: "wegent://modal/mcp-provider-config?provider=dingtalk&service=docs"
    modalText: "打开钉钉 MCP 配置弹窗"
mcpServers:
  dingtalk-docs:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.docs.credentials.url}}"
    timeout: 300
  dingtalk-table:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.table.credentials.url}}"
    timeout: 300
  dingtalk-ai-table:
    type: streamable-http
    url: "${{task_data.user_mcps.dingtalk.services.ai_table.credentials.url}}"
    timeout: 300
  wegent-knowledge:
    type: streamable-http
    url: "${{backend_url}}/mcp/knowledge/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# DingTalk Knowledge Upload Skill

Upload DingTalk documents, spreadsheets, and AI tables to Wegent knowledge bases.

## When To Use

- The user wants to add a DingTalk document to a knowledge base
- The user mentions URLs like:
  - `https://alidocs.dingtalk.com/i/nodes/...` (DingTalk Docs)
  - `https://alidocs.dingtalk.com/i/spreadsheet/...` (DingTalk Table)
  - `https://alidocs.dingtalk.com/i/ai/...` (DingTalk AI Table)

## Workflow

When user wants to upload a DingTalk document to knowledge base:

### Step 1: Parse URL
Identify document type from the DingTalk URL:
- Docs: `https://alidocs.dingtalk.com/i/nodes/{node_id}`
- Table: `https://alidocs.dingtalk.com/i/spreadsheet/{doc_id}`
- AI Table: `https://alidocs.dingtalk.com/i/ai/{doc_id}`

### Step 2: Get Document Info
**IMPORTANT: Always call get_document_info first!** This returns document metadata including `contentType` and `extension` fields which determine which tool to use next.

For docs (dingtalk-docs MCP):
```
dingtalk-docs.get_document_info(document_id="xxx")
```

Returns key fields:
- `name`: Document title
- `contentType`: Document content type (ALIDOC or other)
- `extension`: File extension (adoc, axls, able, docx, xlsx, etc.)
- `nodeType`: Node type (file, folder, etc.)

### Step 3: Route Based on contentType and extension

Based on `get_document_info` response, choose the appropriate tool:

| contentType | extension | Tool to Use |
|-------------|-----------|-------------|
| ALIDOC | adoc | `get_document_content(nodeId)` - Returns Markdown content |
| ALIDOC | axls | Use dingtalk-table MCP: `get_all_sheets(nodeId)` then `get_range(nodeId, sheetId, range)` |
| ALIDOC | able | Use dingtalk-ai-table MCP: `get_tables(nodeId)` then `query_records(nodeId, tableId)` |
| ≠ALIDOC | file | `download_file(nodeId)` - Returns file download URL |

#### Option A: Online Document (adoc) - contentType=ALIDOC, extension=adoc
Call `get_document_content` to get markdown content:
```
dingtalk-docs.get_document_content(nodeId="xxx")
```
Returns: `{"markdown": "# Title\n\nContent...", ...}`

Then proceed to Step 4B.

#### Option B: Spreadsheet (axls) - contentType=ALIDOC, extension=axls
Use dingtalk-table MCP:
```
# Get all sheets
dingtalk-table.get_all_sheets(nodeId="xxx")
# Returns: [{"sheetId": "1", "name": "Sheet1"}, ...]

# Read data from specific sheet
dingtalk-table.get_range(nodeId="xxx", sheetId="1", range="A1:Z100")
```

#### Option C: AI Table (able) - contentType=ALIDOC, extension=able
Use dingtalk-ai-table MCP:
```
# Get all tables (nodeId is baseId)
dingtalk-ai-table.get_tables(nodeId="xxx")
# Returns: [{"tableId": "1", "name": "Table1"}, ...]

# Query records
dingtalk-ai-table.query_records(nodeId="xxx", tableId="1")
```

#### Option D: File-based Document - contentType≠ALIDOC, nodeType=file
Call `download_file` to get download URL:
```
dingtalk-docs.download_file(nodeId="xxx")
```
Returns: `{"download_url": "https://...", "download_token": "..."}`

Then proceed to Step 4A.

### Step 4A: Download and Upload via Sandbox (for file-based documents)
**CRITICAL: You MUST use the dingtalk_knowledge provider tool to download the file in sandbox.**

If you got a `download_url` from Option D:
1. Start a sandbox environment
2. Use the dingtalk_knowledge provider tool to download the file in sandbox:
```python
dingtalk_knowledge.download_dingtalk_document(
    download_url="{download_url_from_step_3}",
    file_extension="{extension_from_get_document_info}",  # e.g., "docx", "xlsx", "pdf"
    filename="{document_name}.{extension}"  # Optional, will auto-generate if not provided
)
```
This returns an `attachment_id` that was created by uploading the file from sandbox to Wegent.

**DO NOT** call `wegent-knowledge.create_document` directly with a URL - you must first download the file in sandbox using the provider tool.

### Step 4B: Save Content and Upload via Sandbox (for online documents)
**CRITICAL: You MUST use the dingtalk_knowledge provider tool to save content in sandbox.**

If you got content from Option A (adoc):
1. Start a sandbox environment
2. Use the dingtalk_knowledge provider tool to save the content to a file in sandbox:
```python
dingtalk_knowledge.save_dingtalk_content(
    content="{markdown_content_from_get_document_content}",
    file_extension="md",  # IMPORTANT: Use "md" for adoc content since it's markdown format
    filename="{document_name}.md"  # Optional, will auto-generate if not provided
)
```
This returns an `attachment_id` that was created by uploading the file from sandbox to Wegent.

**Important:** The content from `get_document_content` is always in markdown format, so you MUST use `file_extension="md"`.

**DO NOT** create the attachment directly - you must use the provider tool which handles sandbox file operations.

### Step 5: Create Knowledge Base Document
Use the wegent-knowledge MCP server's `create_document` tool to create the document in knowledge base with source attribution:

```python
wegent-knowledge.create_document(
    knowledge_base_id=123,  # REQUIRED: The target knowledge base ID
    name="Document Name",   # Use the document name from get_document_info
    source_type="attachment",  # REQUIRED: Must be "attachment" since we have attachment_id
    attachment_id=456,      # REQUIRED: From Step 4A or 4B
    trigger_indexing=True
)
```

**Important:** This calls the Wegent knowledge MCP tool (defined in `backend/app/mcp_server/tools/knowledge.py`), NOT a provider tool.

Parameters:
- `knowledge_base_id`: **Required.** The target knowledge base ID (integer). Get this from user input or by listing knowledge bases.
- `name`: **Required.** Document name (use the document name from get_document_info)
- `source_type`: **Required.** Use "attachment" since we have an attachment_id
- `attachment_id`: **Required.** The attachment ID returned from Step 4A or 4B
- `trigger_indexing`: Set to true to enable RAG indexing

**Common Error:** If you see "knowledge_base_id: Field required", it means you forgot to include the `knowledge_base_id` parameter in the tool call. All three parameters (knowledge_base_id, name, source_type) are required.

## Error Handling

If MCP tools report a permissions or configuration problem:
1. Check if the user has configured the corresponding DingTalk MCP service
2. Guide the user to Settings → Integrations → DingTalk to configure
3. Do not proceed without proper configuration

## Examples

### Example 1: File-based Document (Word, Excel, PDF, etc.)

User: "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/nYMoOje9 添加到知识库 '产品文档'"

Steps:
1. Parse URL → node_id="nYMoOje9"
2. Call dingtalk-docs.get_document_info(document_id="nYMoOje9")
   - Returns: `{"name": "产品需求", "contentType": "FILE", "extension": "docx", "nodeType": "file", ...}`
3. Since contentType≠ALIDOC and nodeType=file, call dingtalk-docs.download_file(nodeId="nYMoOje9")
   - Returns: `{"download_url": "https://...", "download_token": "..."}`
4. Call dingtalk_knowledge.download_dingtalk_document in sandbox:
   ```python
   dingtalk_knowledge.download_dingtalk_document(
       download_url="https://alidocs.dingtalk.com/...",
       file_extension="docx",  # From get_document_info extension field
       filename="产品需求.docx"
   )
   ```
   - Returns: `{success: true, attachment_id: 123, filename: "产品需求.docx", ...}`
5. Call wegent-knowledge.create_document:
   ```python
   wegent-knowledge.create_document(
       knowledge_base_id=1,  # Target knowledge base ID
       name="产品需求",  # From get_document_info
       source_type="attachment",
       attachment_id=123,  # From step 4
       trigger_indexing=True
   )
   ```

### Example 2: Online Document (adoc)

User: "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/AbCdEfGh 添加到知识库"

Steps:
1. Parse URL → node_id="AbCdEfGh"
2. Call dingtalk-docs.get_document_info(document_id="AbCdEfGh")
   - Returns: `{"name": "产品需求", "contentType": "ALIDOC", "extension": "adoc", ...}`
3. Since contentType=ALIDOC and extension=adoc, call dingtalk-docs.get_document_content(nodeId="AbCdEfGh")
   - Returns: `{"markdown": "# Title\n\nContent...", ...}`
4. Call dingtalk_knowledge.save_dingtalk_content in sandbox:
   ```python
   dingtalk_knowledge.save_dingtalk_content(
       content="# Title\n\nContent...",
       file_extension="md",  # IMPORTANT: Use "md" for adoc content
       filename="产品需求.md"
   )
   ```
   - Returns: `{success: true, attachment_id: 456, filename: "产品需求.md", ...}`
5. Call wegent-knowledge.create_document:
   ```python
   wegent-knowledge.create_document(
       knowledge_base_id=1,  # Target knowledge base ID
       name="产品需求",  # From get_document_info
       source_type="attachment",
       attachment_id=456,  # From step 4
       trigger_indexing=True
   )
   ```
