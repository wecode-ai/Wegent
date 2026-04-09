---
description: "Knowledge base management tools for Wegent. Provides capabilities to list, create, and update knowledge bases and documents. Use this skill when the user wants to manage knowledge bases or documents programmatically."
displayName: "知识库工具"
version: "1.0.0"
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

- **list_knowledge_bases**: List all knowledge bases accessible to the current user
  - scope: "personal" (your own), "group" (team), or "all" (default)
  - group_name: Specify group name when scope="group"

- **list_documents**: List all documents in a knowledge base
  - knowledge_base_id: ID of the knowledge base

- **create_knowledge_base**: Create a new knowledge base
  - name: Knowledge base display name
  - description: Optional description
  - namespace: "default" (personal) or a group namespace (requires Maintainer+)
  - kb_type: "notebook" (default) or "classic"
  - summary_enabled: Enable automatic summary generation (default: true)

- **create_document**: Create a new document in a knowledge base
  - knowledge_base_id: Target knowledge base ID
  - name: Document name
  - source_type: "text" (paste content), "file" (base64 encoded), or "web" (URL to scrape)
  - content: Document content when source_type="text"
  - file_base64: Base64 encoded file when source_type="file"
  - file_extension: File extension when source_type="file"
  - url: URL to fetch when source_type="web"
  - trigger_indexing: Whether to trigger RAG indexing (default: true)
  - trigger_summary: Whether to trigger summary generation (default: true)

- **read_document_content**: Read raw document content with offset/limit pagination
  - document_id: Document ID to read
  - offset: Character offset to start reading from (default: 0)
  - limit: Maximum number of characters to return (uses the backend default when omitted)
  - returns: content slice, total_length, returned_length, has_more, kb_id

- **update_document_content**: Update a document's content for text documents and editable plain-text files
  - document_id: Document ID to update
  - content: New content (replaces existing content)
  - trigger_reindex: Whether to trigger RAG re-indexing (default: true)

- **sync_document**: Sync (create or update) a document to a knowledge base
  - knowledge_base_id: Target knowledge base ID
  - name: Document name (used as the unique key — if a document with this name already exists, it will be updated)
  - source_type: "text" (paste content), "file" (base64 encoded), or "attachment" (reference an uploaded attachment by ID)
  - content: Document content when source_type="text"
  - file_base64: Base64 encoded file when source_type="file"
  - file_extension: File extension (optional — inferred from attachment metadata if omitted)
  - attachment_id: Attachment ID when source_type="attachment" (recommended for binary/large files)
  - trigger_indexing: Whether to trigger RAG indexing (default: true)
  - trigger_summary: Whether to trigger summary generation (default: true)

## Usage Notes

- All operations inherit the current user's permissions
- After creating or updating documents, indexing happens asynchronously
- Documents may show status "pending" until indexing completes
- For web scraping, the URL content is fetched and stored as document content
- `update_document_content` supports `text` documents and plain-text file documents such as `txt`, `md`, and `markdown`; binary files like `pdf` or `docx` still require creating or replacing the source file instead of inline editing
- Default behavior: if user doesn't specify scope, use `scope="all"` directly (no extra confirmation).
- Avoid loops: if a tool call fails, report the error once and stop retrying/re-loading the skill unless the user changes inputs.
- Long documents should be read incrementally: start with the backend default limit, then continue with `offset = previous_offset + previous_returned_length` while `has_more=true`

## Example Workflow

1. First, list available knowledge bases:
   ```
   list_knowledge_bases(scope="all")
   ```

2. List documents in a specific knowledge base:
   ```
   list_documents(knowledge_base_id=123)
   ```

3. Create a new knowledge base:
   ```
   create_knowledge_base(
     name="My KB",
     description="My personal notes",
     namespace="default",
     kb_type="notebook"
   )
   ```

4. Create a new text document:
   ```
   create_document(
     knowledge_base_id=123,
     name="Meeting Notes",
     source_type="text",
     content="Notes from today's meeting..."
   )
   ```

5. Update document content:
   ```text
   update_document_content(
     document_id=456,
     content="Updated notes with new information...",
     trigger_reindex=true
   )
   ```

6. Read long document content incrementally:
   ```text
   read_document_content(
     document_id=456,
     offset=0
   )
   ```

## Syncing External Documents (e.g., DingTalk)

When you need to sync an external document (e.g., from DingTalk) into a Wegent knowledge base, use one of the following approaches depending on the document type.

### For DingTalk Online Documents (text-based)

If the DingTalk MCP `get_document_content` tool is available, read the document content as Markdown and sync directly:

```
content = get_document_content(nodeId="<document_id>")
sync_document(
  knowledge_base_id=123,
  name="Meeting Notes.md",
  source_type="text",
  content=content
)
```

### For Binary Files (PDF, DOCX, Excel, etc.)

Binary files require a three-step flow: **download → upload as attachment → sync**.

**Step 1**: Use DingTalk MCP `download_file` to get download credentials:
```
credentials = download_file(nodeId="<document_id>")
# Returns: resourceUrl (array of URLs) and headers (signed request headers)
```

**Step 2**: Download the file locally and upload it as an attachment via `curl`:
```bash
# Download the file using credentials from step 1
curl -o /tmp/document.pdf "<resourceUrl>" -H "<header1>" -H "<header2>"

# Upload to Wegent as an attachment (returns JSON with attachment id)
curl -s -X POST \
  -H "Authorization: Bearer $WEGENT_TASK_TOKEN" \
  -F "file=@/tmp/document.pdf" \
  "$WEGENT_BACKEND_URL/api/attachments/upload"
# Response: {"id": 456, "filename": "document.pdf", ...}
```

**Step 3**: Sync the attachment to the knowledge base:
```
sync_document(
  knowledge_base_id=123,
  name="document.pdf",
  source_type="attachment",
  attachment_id=456
)
```

**Environment variables** `$WEGENT_BACKEND_URL` and `$WEGENT_TASK_TOKEN` are pre-configured in the executor environment.
