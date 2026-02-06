---
name: knowledge
description: Manage knowledge bases and documents in Wegent. Create, list, delete knowledge bases. Add documents from files, text, or web URLs. Query and manage document status.
---

# Knowledge Base Management

Manage knowledge bases and documents in Wegent.

## Authentication

Token is automatically read from:
1. `WEGENT_API_TOKEN` environment variable
2. `~/.wecode-cli/config.json` → `.auth.token`

API base URL can be set via `WEGENT_API_BASE` (default: `https://wegent.intra.weibo.com/api`).

## Tool Usage

```bash
scripts/knowledge-tool '{"action": "<action>", ...params}'
```

Or via stdin (recommended for long content):
```bash
echo '{"action": "<action>", ...}' | scripts/knowledge-tool
```

## Available Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| `list-kb` | List knowledge bases | `scope?`, `groupName?` |
| `get-kb` | Get KB details | `kbId` |
| `create-kb` | Create new KB | `name`, `description?`, `namespace?` |
| `delete-kb` | Delete KB | `kbId` |
| `list-documents` | List documents in KB | `kbId` |
| `get-document` | Get document details | `documentId`, `includeContent?`, `includeSummary?` |
| `add-web-document` | Add web page | `kbId`, `url`, `name?` |
| `add-text-document` | Add text content | `kbId`, `name`, `content` or `contentFile`, `sourceUrl?` |
| `upload-file` | Upload file | `kbId`, `file`, `name?` |
| `toggle-document` | Enable/disable doc | `documentId`, `enable` or `disable` |
| `delete-document` | Delete document | `documentId` |

## Examples

### Knowledge Base Operations

```bash
# List all knowledge bases
scripts/knowledge-tool '{"action": "list-kb"}'

# List personal knowledge bases only
scripts/knowledge-tool '{"action": "list-kb", "scope": "personal"}'

# Create a new knowledge base
scripts/knowledge-tool '{"action": "create-kb", "name": "My Notes", "description": "Personal notes"}'

# Get knowledge base details
scripts/knowledge-tool '{"action": "get-kb", "kbId": 123}'

# Delete knowledge base
scripts/knowledge-tool '{"action": "delete-kb", "kbId": 123}'
```

### Document Operations

```bash
# List documents in a knowledge base
scripts/knowledge-tool '{"action": "list-documents", "kbId": 123}'

# Add a web page
scripts/knowledge-tool '{"action": "add-web-document", "kbId": 123, "url": "https://example.com/doc"}'

# Add text content from file (recommended for long content)
scripts/knowledge-tool '{"action": "add-text-document", "kbId": 123, "name": "API Docs", "contentFile": "/tmp/content.txt"}'

# Add text content directly (short content only)
scripts/knowledge-tool '{"action": "add-text-document", "kbId": 123, "name": "Note", "content": "Short note"}'

# Upload a file (PDF, Word, etc.)
scripts/knowledge-tool '{"action": "upload-file", "kbId": 123, "file": "/path/to/document.pdf"}'

# Get document details
scripts/knowledge-tool '{"action": "get-document", "documentId": 456}'

# Enable a document
scripts/knowledge-tool '{"action": "toggle-document", "documentId": 456, "enable": true}'

# Disable a document
scripts/knowledge-tool '{"action": "toggle-document", "documentId": 456, "disable": true}'

# Delete a document
scripts/knowledge-tool '{"action": "delete-document", "documentId": 456}'
```

## Supported File Types

- **Documents**: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx)
- **Text**: TXT, Markdown (.md)
- **Images**: PNG, JPG, JPEG, GIF, WebP
- **Max file size**: 100MB

## Error Handling

All responses are JSON. On error:
```json
{"ok": false, "error": "Error message"}
```
