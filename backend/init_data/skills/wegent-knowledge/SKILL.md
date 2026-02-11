---
description: "Knowledge base management tools for Wegent. Provides capabilities to list, create, and update knowledge bases and documents. Use this skill when the user wants to manage knowledge bases or documents programmatically."
displayName: "Wegent Knowledge Base"
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
  - status: "enabled", "disabled", or "all" (default)

- **create_knowledge_base**: Create a new knowledge base
  - name: Knowledge base display name
  - description: Optional description
  - namespace: "default" (personal) or a group namespace (requires Maintainer+)
  - kb_type: "notebook" (default) or "classic"
  - summary_enabled: Enable automatic summary generation (default: false)

- **create_document**: Create a new document in a knowledge base
  - knowledge_base_id: Target knowledge base ID
  - name: Document name
  - source_type: "text" (paste content), "file" (base64 encoded), or "web" (URL to scrape)
  - content: Document content when source_type="text"
  - file_base64: Base64 encoded file when source_type="file"
  - file_extension: File extension when source_type="file"
  - url: URL to fetch when source_type="web"

- **delete_document**: Delete a document from a knowledge base
  - document_id: Document ID to delete

- **update_document**: Update a document's content
  - document_id: Document ID to update
  - content: New content
  - mode: "replace" (default) or "append"

## Usage Notes

- All operations inherit the current user's permissions
- After creating or updating documents, indexing happens asynchronously
- Documents may show status "pending" until indexing completes
- For web scraping, the URL content is fetched and stored as document content
- Default behavior: if user doesn't specify scope, use `scope="all"` directly (no extra confirmation).
- Avoid loops: if a tool call fails, report the error once and stop retrying/re-loading the skill unless the user changes inputs.

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

5. Append content to an existing document:
   ```
   update_document(
     document_id=456,
     content="Additional notes...",
     mode="append"
   )
   ```

6. Delete a document:
   ```
   delete_document(document_id=456)
   ```
