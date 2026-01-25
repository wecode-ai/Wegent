# External Knowledge Import

This guide explains how to send external content (for example, messages captured by a service that watches `@` mentions on Weibo) into Wegent knowledge bases.

## Overview

The external import endpoint accepts plain text, stores it as a document attachment, and creates a knowledge base document. If the knowledge base has retrieval configured, indexing is scheduled automatically.

## Authentication

Use an API key in one of the supported headers:

- `X-API-Key: wg-...`
- `Authorization: Bearer wg-...`

If you are using a service key and need to impersonate a user, pass `wegent-username` (or use `api_key#username`).

## Endpoint

`POST /api/knowledge-bases/{knowledge_base_id}/external-imports`

## Request Body

```json
{
  "title": "Weibo Clip",
  "content": "Hello Wegent external import.",
  "source": "weibo",
  "source_url": "https://weibo.com/example",
  "external_id": "weibo-123",
  "author": "alice",
  "tags": ["social", "clip"],
  "metadata": { "channel": "mentions" }
}
```

## Example

```bash
curl -X POST "http://localhost:8000/api/knowledge-bases/42/external-imports" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: wg-your-key" \
  -d '{
    "title": "Weibo Clip",
    "content": "Hello Wegent external import.",
    "source": "weibo",
    "source_url": "https://weibo.com/example",
    "external_id": "weibo-123",
    "author": "alice",
    "tags": ["social", "clip"],
    "metadata": { "channel": "mentions" }
  }'
```

## Response Fields

- `knowledge_base_id`: Target knowledge base ID.
- `attachment_id`: Attachment record created for the content.
- `index_scheduled`: `true` if RAG indexing was scheduled.
- `truncation_info`: Details if the content was truncated.
- `document`: The created knowledge document metadata.
