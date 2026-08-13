---
description: "Knowledge base management, RAG search, parsed document reading, and original source-file download tools for Wegent. Use this skill whenever the user selects or references Wegent knowledge bases, asks questions over knowledge documents, or needs precise spreadsheet, binary, parser-failed, or full-file analysis."
displayName: "知识库工具"
version: "1.1.0"
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

- **wegent_kb_read_document_content**: Read raw document content with offset/limit pagination
  - document_id: Document ID to read
  - offset: Character offset to start reading from (default: 0)
  - limit: Maximum number of characters to return (uses the backend default when omitted)
  - returns: content slice, total_length, returned_length, has_more, kb_id

- **wegent_kb_get_document_download**: Get a short-lived download credential for the original source file
  - document_id: Document ID to download
  - disposition: Use "attachment" when saving the file locally (default); use "inline" only for previewable files
  - returns: resource_url, required headers, expiration_seconds, file metadata, and a curl download command template

- **wegent_kb_update_document_content**: Update a document's content for text documents and editable plain-text files
  - document_id: Document ID to update
  - content: New content (replaces existing content)
  - trigger_reindex: Whether to trigger RAG re-indexing (default: true)

- **wegent_kb_search_knowledge_base**: Search documents using RAG retrieval
  - knowledge_base_id: Knowledge base ID to search
  - query: Search query text
  - max_results: Maximum results to return (default: 10, max: 50)
  - document_ids: Optional list of document IDs to filter search scope
  - folder_ids: Optional list of selected folder IDs
  - include_subfolders: Whether folder IDs include descendants

## Usage Notes

- All operations inherit the current user's permissions
- A folder in `<selected_knowledge_sources>` always includes all descendant folders. Pass its original ID through `folder_id`/`folder_ids`; omitted `include_subfolders` defaults to `true`. Never broaden the request to the whole knowledge base to discover descendants.
- For a selected document, pass its original ID through `document_ids` instead of broadening to the whole knowledge base.
- After creating or updating documents, indexing happens asynchronously
- Documents may show status "pending" until indexing completes
- For web scraping, the URL content is fetched and stored as document content
- `wegent_kb_update_document_content` supports `text` documents and plain-text file documents such as `txt`, `md`, and `markdown`; binary files like `pdf` or `docx` still require creating or replacing the source file instead of inline editing
- Default behavior: if user doesn't specify scope, use `scope="all"` directly (no extra confirmation).
- Avoid loops: if a tool call fails, report the error once and stop retrying/re-loading the skill unless the user changes inputs.
- Long documents should be read incrementally: start with the backend default limit, then continue with `offset = previous_offset + previous_returned_length` while `has_more=true`
- Choose the access mode yourself. Use RAG search for semantic lookup, `wegent_kb_read_document_content` for parsed text slices, and `wegent_kb_get_document_download` when exact spreadsheet calculations, binary formats, parser failures, or full-file analysis require the original source file.
- Do not ask the user to confirm which access mode to use when enough context is available. Locate the likely document with RAG or list tools, then download the source file if the task needs full-file precision.
- When using a download credential, use the returned headers exactly. If `resource_url` is relative, prefix it with `TASK_API_DOMAIN` or use the returned `download_command` template.

## Example Workflow

1. First, list available knowledge bases:
   ```
   wegent_kb_list_knowledge_bases(scope="all")
   ```

2. List documents in a specific knowledge base:
   ```
   wegent_kb_list_documents(knowledge_base_id=123, limit=20, offset=0)
   ```

   If `has_more=true`, continue with:
   ```
   wegent_kb_list_documents(knowledge_base_id=123, limit=20, offset=20)
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

7. Download the original source file for precise spreadsheet or full-file analysis:
   ```text
   wegent_kb_get_document_download(
     document_id=456,
     disposition="attachment"
   )
   ```

8. Search knowledge base using RAG retrieval:
   ```text
   wegent_kb_search_knowledge_base(
     knowledge_base_id=123,
     query="How to configure the system?",
     max_results=10
   )
   ```

9. Search within specific documents:
   ```text
   wegent_kb_search_knowledge_base(
     knowledge_base_id=123,
     query="deployment steps",
     max_results=5,
     document_ids=[456, 789]
   )
   ```
