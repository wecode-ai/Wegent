---
sidebar_position: 2
---

# Knowledge Open API

This document describes the `/api/knowledge/*` open APIs for managing knowledge documents, folders, and direct knowledge retrieval from external systems.

If you want an agent to use a knowledge base through `/api/v1/responses`, see the `knowledge_base` tool configuration in [OpenAPI v1/responses API](./openapi-responses-api.md).

## Authentication

All endpoints require one of the following authentication methods:

- `Authorization: Bearer <access_token>`
- `X-API-Key: <api_key>`

When using a service API key, pass `wegent-username` to specify the target user.

## Base URL

```text
/api/knowledge
```

## Common Rules

- `knowledge_base_id` is the knowledge base ID.
- `document_id` is the knowledge document ID.
- `folder_id=0` means the root folder.
- Omitting `folder_id` means no folder filter.
- `folder_ids=[0]` means documents directly under root. It does not mean whole-knowledge-base search.
- For whole-knowledge-base search, omit both `folder_ids` and `document_ids`.
- `folder_ids=[]` and `document_ids=[]` are invalid.

## Knowledge Bases

### List Accessible Knowledge Bases

```http
GET /api/knowledge/list
```

Query parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | No | `personal` returns personal accessible knowledge bases; `all` returns personal, group, and organization accessible knowledge bases. Default: `all` |

Response:

```json
{
  "total": 1,
  "items": [
    {
      "id": 1,
      "name": "Product KB",
      "namespace": "default",
      "document_count": 12
    }
  ]
}
```

## Documents

### List Documents

```http
GET /api/knowledge/documents
```

Query parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `knowledge_base_id` | integer | Yes | Knowledge base ID |
| `folder_id` | integer | No | Folder filter. `0` means documents directly under root; omitted means all documents; values greater than `0` return only direct documents in that folder, not recursively |

Response:

```json
{
  "total": 1,
  "items": [
    {
      "id": 101,
      "kind_id": 1,
      "name": "design.md",
      "file_extension": "md",
      "status": "enabled",
      "index_status": "success",
      "folder_id": 0
    }
  ]
}
```

### Read Document Content

```http
GET /api/knowledge/documents/{document_id}/content
```

Query parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `offset` | integer | No | Start character offset. Default: `0` |
| `limit` | integer | No | Maximum characters to return. Default and maximum are server controlled |

Response:

```json
{
  "document_id": 101,
  "name": "design.md",
  "content": "Partial document content",
  "total_length": 12000,
  "offset": 0,
  "returned_length": 2000,
  "has_more": true,
  "kb_id": 1,
  "index_status": "success"
}
```

### Create Document

```http
POST /api/knowledge/documents
```

Request body fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `knowledge_base_id` | integer | Yes | Target knowledge base ID |
| `name` | string | Yes | Document name |
| `source_type` | string | No | `text`, `file`, `web`, or `attachment`. Default: `text` |
| `content` | string | Conditionally | Text content for `source_type=text` |
| `file_base64` | string | Conditionally | Base64-encoded file for `source_type=file`; decoded size limit is 10 MB |
| `file_extension` | string | Conditionally | File extension without a leading dot. Required for `file`; optional for `text` |
| `url` | string | Conditionally | Web page URL for `source_type=web` |
| `attachment_id` | integer | Conditionally | Existing attachment ID for `source_type=attachment` |
| `folder_id` | integer | No | Target folder ID. `0` means root. Default: `0` |
| `splitter_config` | object | No | Custom chunking configuration |

Text example:

```json
{
  "knowledge_base_id": 1,
  "name": "design.md",
  "source_type": "text",
  "content": "# Design\n\nBody",
  "file_extension": "md",
  "folder_id": 0
}
```

Web example:

```json
{
  "knowledge_base_id": 1,
  "name": "Website docs",
  "source_type": "web",
  "url": "https://example.com/docs",
  "folder_id": 10
}
```

### Update Document Metadata

```http
PUT /api/knowledge/documents/{document_id}
```

Request body fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | New document name |
| `status` | string | No | `enabled` or `disabled` |
| `splitter_config` | object | No | Chunking configuration |

This endpoint updates metadata only. It does not update document text content.

### Update Document Content

```http
PUT /api/knowledge/documents/{document_id}/content
```

Request body:

```json
{
  "content": "New Markdown content"
}
```

Only text documents and plain-text file documents are supported. Updating content triggers re-indexing.

### Move Document

```http
PUT /api/knowledge/documents/{document_id}/move
```

Request body:

```json
{
  "folder_id": 10
}
```

Use `folder_id=0` to move the document to root.

## Folders

Folders are knowledge document metadata, not attachment metadata. The generic attachment upload API does not accept `folder_id`.

### Get Folder Tree

```http
GET /api/knowledge/folders?knowledge_base_id=1
```

The response contains the full folder tree, including empty folders:

```json
[
  {
    "id": 10,
    "kind_id": 1,
    "parent_id": 0,
    "name": "Product",
    "document_count": 3,
    "children": []
  }
]
```

### Create Folder

```http
POST /api/knowledge/folders
```

Request body:

```json
{
  "knowledge_base_id": 1,
  "name": "Product",
  "parent_id": 0
}
```

### Update Folder

```http
PUT /api/knowledge/folders/{folder_id}
```

Request body:

```json
{
  "knowledge_base_id": 1,
  "name": "Product Docs",
  "parent_id": 0
}
```

`name` and `parent_id` are optional, but `knowledge_base_id` is required for ownership validation.

### Delete Folder

```http
DELETE /api/knowledge/folders/{folder_id}?knowledge_base_id=1
```

Deletes the folder subtree and moves documents under the deleted folders to root.

## Search

### Retrieve Document Chunks

```http
POST /api/knowledge/search
```

Request body fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `knowledge_base_id` | integer | Yes | Knowledge base ID |
| `query` | string | Yes | Search query. Maximum 2000 characters |
| `top_k` | integer | No | Number of results. Default: `5`, range: `1` to `100` |
| `score_threshold` | number | No | Minimum similarity score. Default: `0.7` |
| `route_mode` | string | No | `auto`, `direct_injection`, or `rag_retrieval`. Default: `auto` |
| `folder_ids` | integer[] | No | Folder scope. `[0]` means documents directly under root |
| `document_ids` | integer[] | No | Specific document scope |
| `include_subfolders` | boolean | No | Whether `folder_ids` includes descendants. Default: `true` |
| `context_window` | integer | No | Context window size for direct injection mode |
| `used_context_tokens` | integer | No | Already used context tokens |
| `reserved_output_tokens` | integer | No | Reserved output tokens |
| `context_buffer_ratio` | number | No | Safety buffer ratio for context |
| `max_direct_chunks` | integer | No | Maximum chunks for direct injection |

Whole-knowledge-base search:

```json
{
  "knowledge_base_id": 1,
  "query": "scoped search design",
  "top_k": 5
}
```

Folder-scoped search:

```json
{
  "knowledge_base_id": 1,
  "query": "scoped search design",
  "folder_ids": [10],
  "include_subfolders": true,
  "top_k": 5
}
```

Document-scoped search:

```json
{
  "knowledge_base_id": 1,
  "query": "scoped search design",
  "document_ids": [101, 102]
}
```

Scope rules:

- Whole-knowledge-base search: omit both `folder_ids` and `document_ids`.
- Root-folder search: pass `folder_ids: [0]`.
- Subfolder search: pass `folder_ids: [10]` and use `include_subfolders` to control whether descendants are included.
- When both `folder_ids` and `document_ids` are provided, the scope is their union.
- `folder_ids=[]` or `document_ids=[]` is invalid.
- If the specified scope contains no documents, the API returns empty results and does not fall back to whole-knowledge-base search.

Response:

```json
{
  "records": [
    {
      "content": "Matched chunk content",
      "score": 0.86,
      "title": "design.md"
    }
  ]
}
```

## Error Codes

| Status | Meaning |
|--------|---------|
| `400` | Semantic parameter error, such as a folder outside the knowledge base or incomplete retrieval configuration |
| `403` | The current user cannot access the target knowledge base, folder, or document |
| `404` | Knowledge base, folder, or document not found |
| `422` | Request validation failed, such as empty arrays, missing conditional fields, or out-of-range values |
| `502` | Upstream web scraping or RAG gateway error |
