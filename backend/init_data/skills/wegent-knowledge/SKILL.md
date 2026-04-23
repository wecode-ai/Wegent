---
description: "Knowledge base management and search tools for Wegent. Provides capabilities to list, create, update, and search knowledge bases and documents using RAG retrieval. Also supports uploading DingTalk documents, spreadsheets, and AI tables to knowledge base with proper source attribution."
displayName: "知识库工具"
version: "1.0.1"
author: "Wegent Team"
tags: ["knowledge", "knowledge-base", "document", "rag", "dingtalk", "spreadsheet", "ai-table"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
config:
  unconfiguredGuide:
    modalLink: "wegent://modal/mcp-provider-config?provider=dingtalk&service=docs"
    modalText: "打开钉钉 MCP 配置弹窗"
mcpServers:
  wegent-knowledge:
    type: streamable-http
    # NOTE: MCP client only supports ${{...}} variable substitution.
    # The platform will inject `backend_url` via task_data.
    url: "${{backend_url}}/mcp/knowledge/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
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
---

# Wegent Knowledge Base Skill

You now have access to Wegent Knowledge Base management tools.

## Available Tools

- **wegent_kb_list_knowledge_bases**: List all knowledge bases accessible to the current user
  - scope: "personal" (your own), "group" (team), or "all" (default)
  - group_name: Specify group name when scope="group"

- **wegent_kb_list_documents**: List all documents in a knowledge base
  - knowledge_base_id: ID of the knowledge base

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
  - max_results: Maximum results to return (default: 10, max: 50)
  - document_ids: Optional list of document IDs to filter search scope

## Usage Notes

- All operations inherit the current user's permissions
- After creating or updating documents, indexing happens asynchronously
- Documents may show status "pending" until indexing completes
- For web scraping, the URL content is fetched and stored as document content
- `wegent_kb_update_document_content` supports `text` documents and plain-text file documents such as `txt`, `md`, and `markdown`; binary files like `pdf` or `docx` still require creating or replacing the source file instead of inline editing
- Default behavior: if user doesn't specify scope, use `scope="all"` directly (no extra confirmation).
- Avoid loops: if a tool call fails, report the error once and stop retrying/re-loading the skill unless the user changes inputs.
- Long documents should be read incrementally: start with the backend default limit, then continue with `offset = previous_offset + previous_returned_length` while `has_more=true`

## Example Workflows for Knowledge Base Management

1. First, list available knowledge bases:
   ```
   wegent_kb_list_knowledge_bases(scope="all")
   ```

2. List documents in a specific knowledge base:
   ```
   wegent_kb_list_documents(knowledge_base_id=123)
   ```

3. Create a new knowledge base:
   ```
   wegent_kb_create_knowledge_base(
     name="My KB",
     description="My personal notes",
     namespace="default",
     kb_type="notebook"
   )
   ```

4. Create a new text document:
   ```
   wegent_kb_create_document(
     knowledge_base_id=123,
     name="Meeting Notes",
     source_type="text",
     content="Notes from today's meeting..."
   )
   ```

5. Update document content:
   ```text
   wegent_kb_update_document_content(
     document_id=456,
     content="Updated notes with new information...",
     trigger_reindex=true
   )
   ```

6. Read long document content incrementally:
   ```text
   wegent_kb_read_document_content(
     document_id=456,
     offset=0
   )
   ```

7. Search knowledge base using RAG retrieval:
   ```text
   wegent_kb_search_knowledge_base(
     knowledge_base_id=123,
     query="How to configure the system?",
     max_results=10
   )
   ```

8. Search within specific documents:
   ```text
   wegent_kb_search_knowledge_base(
     knowledge_base_id=123,
     query="deployment steps",
     max_results=5,
     document_ids=[456, 789]
   )
   ```

## DingTalk Document Upload

This skill also supports uploading DingTalk documents, spreadsheets, and AI tables to **Wegent** knowledge bases.

**Important:** This feature reads documents FROM DingTalk and uploads them TO Wegent's knowledge base. The final document will be stored in Wegent, not in DingTalk.

### When To Use DingTalk Upload

- The user wants to add a DingTalk document to a knowledge base
- The user mentions URLs like:
  - `https://alidocs.dingtalk.com/i/nodes/...` (DingTalk Docs)
  - `https://alidocs.dingtalk.com/i/spreadsheet/...` (DingTalk Table)
  - `https://alidocs.dingtalk.com/i/ai/...` (DingTalk AI Table)

### DingTalk Upload Workflow

When user wants to upload a DingTalk document to knowledge base:

#### Step 1: Parse URL
Identify document type from the DingTalk URL:
- Docs: `https://alidocs.dingtalk.com/i/nodes/{node_id}`
- Table: `https://alidocs.dingtalk.com/i/spreadsheet/{doc_id}`
- AI Table: `https://alidocs.dingtalk.com/i/ai/{doc_id}`

#### Step 2: Get Document Info
**IMPORTANT: Always call get_document_info first!** This returns document metadata including `contentType` and `file_extension` fields which determine which tool to use next.

For docs (dingtalk-docs MCP):
```
dingtalk-docs.get_document_info(document_id="xxx")
```

Returns key fields:
- `name`: Document title
- `contentType`: Document content type (ALIDOC or other)
- `file_extension`: File extension (adoc, axls, able, docx, xlsx, etc.)
- `nodeType`: Node type (file, folder, etc.)

#### Step 3: Route Based on contentType and extension

Based on `get_document_info` response, choose the appropriate tool:

| contentType | file_extension | Tool to Use |
|-------------|----------------|-------------|
| ALIDOC | adoc | `get_document_content(nodeId)` - Returns Markdown content |
| ALIDOC | axls | Use dingtalk-table MCP: `get_all_sheets(nodeId)` then `get_range(nodeId, sheetId, range)` |
| ALIDOC | able | Use dingtalk-ai-table MCP: `get_tables(nodeId)` then `query_records(nodeId, tableId)` |
| ≠ALIDOC | file | `download_file(nodeId)` - Returns file download URL |

##### Option A: Online Document (adoc) - contentType=ALIDOC, extension=adoc
Call `get_document_content` to get markdown content:
```
dingtalk-docs.get_document_content(nodeId="xxx")
```
Returns: `{"markdown": "# Title\n\nContent...", ...}`

Then proceed to Step 4B.

##### Option B: Spreadsheet (axls) - contentType=ALIDOC, extension=axls
Use dingtalk-table MCP:
```
# Get all sheets
dingtalk-table.get_all_sheets(nodeId="xxx")
# Returns: [{"sheetId": "1", "name": "Sheet1"}, ...]

# Read data from specific sheet
dingtalk-table.get_range(nodeId="xxx", sheetId="1", range="A1:Z100")
```

##### Option C: AI Table (able) - contentType=ALIDOC, extension=able
Use dingtalk-ai-table MCP:
```
# Get all tables (nodeId is baseId)
dingtalk-ai-table.get_tables(nodeId="xxx")
# Returns: [{"tableId": "1", "name": "Table1"}, ...]

# Query records
dingtalk-ai-table.query_records(nodeId="xxx", tableId="1")
```

##### Option D: File-based Document - contentType≠ALIDOC, nodeType=file
Call `download_file` to get download URL:
```
dingtalk-docs.download_file(nodeId="xxx")
```
Returns: `{"download_url": "https://...", "download_token": "..."}`

Then proceed to Step 4A.

#### Step 4A: Download and Upload via Sandbox (for file-based documents)
**CRITICAL: You MUST use the sandbox `exec` tool to download and upload the file.**

If you got a `download_url` from Option D:
1. Use the sandbox `exec` tool to download the file and upload it to Wegent:
```bash
# Download the file
curl -L -o /tmp/{filename}.{ext} "{download_url}"

# Upload to Wegent and capture attachment_id
[ -f /tmp/{filename}.{ext} ] && curl -sS -X POST \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -F "file=@/tmp/{filename}.{ext}" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "${TASK_API_DOMAIN}/api/attachments/upload"
```
Parse the JSON response to extract `attachment_id`.

#### Step 4B: Save Content and Upload via Sandbox (for online documents)
**CRITICAL: You MUST use the sandbox `exec` tool to save content and upload the file.**

If you got content from adoc or axls or able:
1. Must Use the sandbox `exec` tool to write the content to a markdown file and upload it to Wegent:
```bash
# Write markdown content to file
cat > /tmp/{filename}.md << 'EOF'
{markdown_content_from_get_document_content}
EOF

# Upload to Wegent and capture attachment_id
[ -f /tmp/{filename}.md ] && \
curl -sS -X POST \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -F "file=@/tmp/{filename}.md" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "${TASK_API_DOMAIN}/api/attachments/upload"
```
Parse the JSON response to extract `attachment_id`.

**Important:** The content from `get_document_content` is always in markdown format, so save it with `.md` extension.

#### Step 5: Create Document in Wegent Knowledge Base

**⚠️ CRITICAL:** When calling `wegent_kb_create_document`, `source_type` MUST be set to `"attachment"`.

Use the **wegent-knowledge** MCP server's `wegent_kb_create_document` tool to create the document in **Wegent's** knowledge base:

```python
wegent_kb_create_document(
    knowledge_base_id=123,  # REQUIRED: The target Wegent knowledge base ID
    name="Document Name",   # REQUIRED: Use the document name from get_document_info
    source_type="attachment",  # REQUIRED: Must be "attachment" since we have attachment_id
    attachment_id=456,      # REQUIRED: From Step 4A or 4B
    trigger_indexing=True   # REQUIRED
)
```

**⚠️ CRITICAL - DO NOT MAKE THIS MISTAKE:**
- **CORRECT:** `wegent_kb_create_document` - Creates document in Wegent KB ✓
- **WRONG:** `dingtalk-docs.create_document` or `create_document` - Creates document in DingTalk KB ✗

**NEVER** call `dingtalk-docs.create_document` or plain `create_document` - this would create the document in DingTalk's knowledge base, which is NOT what the user wants. The user wants to add the DingTalk document to Wegent's knowledge base.

The `dingtalk-docs` MCP server is **ONLY** for reading documents from DingTalk. The `wegent-knowledge` MCP server's `wegent_kb_*` tools are for managing Wegent's knowledge base.

Parameters:
- `knowledge_base_id`: **Required.** The target Wegent knowledge base ID (integer). Get this from user input or by listing knowledge bases.
- `name`: **Required.** Document name (use the document name from get_document_info)
- `source_type`: **Required.** Use "attachment" since we have an attachment_id
- `attachment_id`: **Required.** The attachment ID returned from Step 4A or 4B
- `trigger_indexing`: Set to true to enable RAG indexing

**Common Error:** If you see "knowledge_base_id: Field required", it means you forgot to include the `knowledge_base_id` parameter in the tool call. All three parameters (knowledge_base_id, name, source_type) are required.

### DingTalk Error Handling

If MCP tools report a permissions or configuration problem:
1. Check if the user has configured the corresponding DingTalk MCP service
2. Guide the user to Settings → Integrations → DingTalk to configure
3. Do not proceed without proper configuration

### DingTalk Upload Examples

#### Example 1: File-based Document (Word, Excel, PDF, etc.)

User: "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/nYMoOje9 添加到知识库 '产品文档'"

Steps:
1. Parse URL → node_id="nYMoOje9"
2. Call dingtalk-docs.get_document_info(document_id="nYMoOje9")
   - Returns: `{"name": "Specifications", "contentType": "FILE", "file_extension": "docx", "nodeType": "file", ...}`
3. Since contentType≠ALIDOC and nodeType=file, call dingtalk-docs.download_file(nodeId="nYMoOje9")
   - Returns: `{"download_url": "https://...", "download_token": "..."}`
4. Use sandbox exec to download and upload:
   ```bash
   curl -L -o /tmp/Specifications.docx "https://alidocs.dingtalk.com/..."

   [ -f /tmp/Specifications.docx ] && \
   curl -sS -X POST \
     -H "Authorization: Bearer ${AUTH_TOKEN}" \
     -F "file=@/tmp/Specifications.docx" \
     -w "\nHTTP_STATUS:%{http_code}" \
     "${TASK_API_DOMAIN}/api/attachments/upload"
   ```
   - Parse response to get `attachment_id: 123`
5. Call **wegent_kb_create_document** to create document in Wegent knowledge base:
   ```python
   wegent_kb_create_document(
       knowledge_base_id=1,      # REQUIRED: Target Wegent knowledge base ID
       name="Specifications",    # REQUIRED: From get_document_info
       source_type="attachment", # REQUIRED
       attachment_id=123,        # REQUIRED: From step 4
       trigger_indexing=True.    # REQUIRED
   )
   ```
   **Result:** Document is now available in Wegent's knowledge base (NOT in DingTalk).

#### Example 2: Online Document (adoc)

User: "将钉钉文档 https://alidocs.dingtalk.com/i/nodes/AbCdEfGh 添加到知识库"

Steps:
1. Parse URL → node_id="AbCdEfGh"
2. Call dingtalk-docs.get_document_info(document_id="AbCdEfGh")
   - Returns: `{"name": "Specifications", "contentType": "ALIDOC", "file_extension": "adoc", ...}`
3. Since contentType=ALIDOC and extension=adoc, call dingtalk-docs.get_document_content(nodeId="AbCdEfGh")
   - Returns: `{"markdown": "# Title\n\nContent...", ...}`
4. Use sandbox exec to save content and upload:
   ```bash
   cat > /tmp/Specifications.md << 'EOF' && \
   # Title

   Content...
   EOF
   [ -f /tmp/Specifications.md ] && \
   curl -sS -X POST \
     -H "Authorization: Bearer ${AUTH_TOKEN}" \
     -F "file=@/tmp/Specifications.md" \
     -w "\nHTTP_STATUS:%{http_code}" \
     "${TASK_API_DOMAIN}/api/attachments/upload"
   ```
   - Parse response to get `attachment_id: 456`
5. Call **wegent_kb_create_document** to create document in Wegent knowledge base:
   ```python
   wegent_kb_create_document(
       knowledge_base_id=1,      # REQUIRED: Target Wegent knowledge base ID
       name="Specifications",    # REQUIRED: From get_document_info
       source_type="attachment", # REQUIRED
       attachment_id=456,        # REQUIRED: From step 4
       trigger_indexing=True.    # REQUIRED
   )
   ```
   **Result:** Document is now available in Wegent's knowledge base (NOT in DingTalk).
