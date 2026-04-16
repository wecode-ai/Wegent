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
- Docs: `https://alidocs.dingtalk.com/i/nodes/{doc_id}`
- Table: `https://alidocs.dingtalk.com/i/spreadsheet/{doc_id}`
- AI Table: `https://alidocs.dingtalk.com/i/ai/{doc_id}`

### Step 2: Get Document Info
Use the appropriate DingTalk MCP tool to query document information:

For docs (dingtalk-docs MCP):
```
get_document_info(document_id="xxx")
```

For tables (dingtalk-table MCP):
```
get_spreadsheet_info(spreadsheet_id="xxx")
```

For AI tables (dingtalk-ai-table MCP):
```
get_ai_table_info(table_id="xxx")
```

### Step 3: Get Document Content

There are two ways to get document content depending on document type:

#### Option A: Download File (for file-based documents)
Call `download_file` tool to get the download URL:
```
download_file(nodeId="xxx")
```

If successful, it returns a `download_url` - proceed to Step 4A.
If it returns an error saying "在线文档不支持直接下载" (online docs not supported), use Option B.

#### Option B: Get Content (for online documents like adoc)
If `download_file` fails for online documents, call:
```
get_document_content(nodeId="xxx")
```

This returns the document content that needs to be saved to a file in sandbox.

### Step 4A: Download and Upload via Sandbox (for file-based documents)
**CRITICAL: You MUST use the dingtalk_knowledge provider tool to download the file in sandbox.**

If you got a `download_url` from Step 3A:
1. Start a sandbox environment
2. Use the dingtalk_knowledge provider tool to download the file in sandbox:
```
download_dingtalk_document(
    download_url="{download_url_from_step_3}",
    filename="document.docx"
)
```
This returns an `attachment_id` that was created by uploading the file from sandbox to Wegent.

**DO NOT** call `wegent-knowledge.create_document` directly with a URL - you must first download the file in sandbox using the provider tool.

### Step 4B: Save Content and Upload via Sandbox (for online documents)
**CRITICAL: You MUST use the dingtalk_knowledge provider tool to save content in sandbox.**

If you got content from Step 3B:
1. Start a sandbox environment
2. Use the dingtalk_knowledge provider tool to save the content to a file in sandbox:
```
save_dingtalk_content(
    content="{content_from_step_3b}",
    filename="document.md"
)
```
This returns an `attachment_id` that was created by uploading the file from sandbox to Wegent.

**DO NOT** create the attachment directly - you must use the provider tool which handles sandbox file operations.

### Step 5: Create Knowledge Base Document
Use the wegent-knowledge MCP server's `create_document` tool to create the document in knowledge base with source attribution:

```
wegent-knowledge.create_document(
    knowledge_base_id=123,
    name="Document Name",
    source_type="attachment",
    attachment_id=456,
    source_config={
        "url": "https://alidocs.dingtalk.com/i/nodes/xxxxx",
        "source": "dingtalk",
        "updated_at": "2026-04-16T10:00:00Z",
        "scraped_at": "2026-04-16T11:00:00Z"
    },
    trigger_indexing=true
)
```

**Important:** This calls the Wegent knowledge MCP tool (defined in `backend/app/mcp_server/tools/knowledge.py`), NOT a provider tool.

Parameters:
- `knowledge_base_id`: The target knowledge base ID
- `name`: Document name (use the document title from get_document_info)
- `source_type`: Use "attachment" since we have an attachment_id
- `attachment_id`: The attachment ID returned from Step 4A or 4B
- `source_config`: JSON object with DingTalk source information
- `trigger_indexing`: Set to true to enable RAG indexing

Note:
- `updated_at` should be the document's last update time from get_document_info
- `scraped_at` should be the current time when uploading

## Source Attribution

When creating the knowledge base document, set the `source_config` field:
```json
{
  "url": "https://alidocs.dingtalk.com/i/nodes/xxxxx",
  "source": "dingtalk",
  "updated_at": "2026-04-16T10:00:00Z",
  "scraped_at": "2026-04-16T11:00:00Z"
}
```

- `url`: The original DingTalk document URL
- `source`: Always "dingtalk"
- `updated_at`: The document's last update time from get_document_info
- `scraped_at`: The current time when the document was uploaded

## Error Handling

If MCP tools report a permissions or configuration problem:
1. Check if the user has configured the corresponding DingTalk MCP service
2. Guide the user to Settings → Integrations → DingTalk to configure
3. Do not proceed without proper configuration

## Examples

### Example 1: File-based Document (Word, Excel, etc.)

User: "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/nYMoOje9 添加到知识库 '产品文档'"

Steps:
1. Parse URL → doc_type="docs", doc_id="nYMoOje9"
2. Call dingtalk-docs.get_document_info(document_id="nYMoOje9")
3. Call dingtalk-docs.download_file(nodeId="nYMoOje9") to get download_url
4. Call dingtalk_knowledge.download_dingtalk_document(download_url="...", filename="xxx.docx") to get attachment_id
5. Call wegent-knowledge.create_document with attachment_id and source_config

### Example 2: Online Document (adoc)

User: "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/AbCdEfGh 添加到知识库"

Steps:
1. Parse URL → doc_type="docs", doc_id="AbCdEfGh"
2. Call dingtalk-docs.get_document_info(document_id="AbCdEfGh")
3. Call dingtalk-docs.download_file(nodeId="AbCdEfGh")
   - Returns error: "在线文档不支持直接下载。请使用 get_document_content 工具获取文档内容。"
4. Call dingtalk-docs.get_document_content(nodeId="AbCdEfGh") to get content
5. Call dingtalk_knowledge.save_dingtalk_content(content="...", filename="xxx.md") to get attachment_id
6. Call wegent-knowledge.create_document with attachment_id and source_config
