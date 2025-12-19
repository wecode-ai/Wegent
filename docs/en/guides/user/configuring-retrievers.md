# Configuring Retrievers for RAG

English | [简体中文](../../zh/guides/user/configuring-retrievers.md)

> ⚠️ **EXPERIMENTAL FEATURE**: The RAG (Retrieval-Augmented Generation) functionality is currently under active development. APIs, configurations, and behaviors may change in future releases.

## Overview

Retrievers are storage backend configurations for RAG (Retrieval-Augmented Generation) functionality in Wegent. They define how documents are indexed, stored, and retrieved using vector databases like Elasticsearch.

## Prerequisites

- Wegent platform installed and running
- Elasticsearch service enabled (optional, only needed for RAG features)
  ```bash
  docker compose --profile rag up -d
  ```

## What is a Retriever?

A Retriever is a CRD (Custom Resource Definition) that configures:
- **Storage Backend**: Vector database connection (Elasticsearch, Qdrant)
- **Index Strategy**: How documents are organized in the database
- **Retrieval Methods**: Search modes (vector, keyword, hybrid)
- **Embedding Configuration**: How text is converted to vectors

## Creating a Retriever

### Via Web UI

1. Navigate to **Settings** → **Retrievers**
2. Click **Add Retriever**
3. Fill in the configuration:
   - **Name**: Unique identifier (e.g., `my-es-retriever`)
   - **Display Name**: Human-readable name
   - **Storage Type**: Select `elasticsearch` or `qdrant`
   - **URL**: Storage backend URL (e.g., `http://elasticsearch:9200`)
   - **Authentication**: Username/password or API key (optional)
   - **Index Strategy**: Choose indexing mode
   - **Retrieval Methods**: Enable vector, keyword, or hybrid search
4. Click **Test Connection** to verify settings
5. Click **Create** to save

### Via API

```bash
POST /api/retrievers
Content-Type: application/json

{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Retriever",
  "metadata": {
    "name": "my-es-retriever",
    "namespace": "default",
    "displayName": "My Elasticsearch Retriever"
  },
  "spec": {
    "storageConfig": {
      "type": "elasticsearch",
      "url": "http://elasticsearch:9200",
      "username": "elastic",
      "password": "password",
      "indexStrategy": {
        "mode": "per_user",
        "prefix": "wegent"
      }
    },
    "retrievalMethods": {
      "vector": {
        "enabled": true,
        "defaultWeight": 0.7
      },
      "keyword": {
        "enabled": true,
        "defaultWeight": 0.3
      },
      "hybrid": {
        "enabled": true
      }
    },
    "description": "Elasticsearch retriever for RAG"
  }
}
```

## Index Strategies

Choose an index strategy based on your use case:

| Strategy | Description | Best For |
|----------|-------------|----------|
| **per_user** | One index per user | Elasticsearch deployments, user-level isolation |
| **per_dataset** | One index per knowledge base | Multi-tenant scenarios, dataset isolation |
| **fixed** | Single fixed index | Small datasets, simple setup |
| **rolling** | Hash-based sharding | Large datasets, load distribution |

### Recommended: per_user Mode

For Elasticsearch, we recommend using `per_user` mode:

```json
{
  "indexStrategy": {
    "mode": "per_user",
    "prefix": "wegent"
  }
}
```

This creates indices like `wegent_user_123`, providing better performance and isolation.

## Retrieval Methods

### Vector Search (Semantic)

Pure vector similarity search for semantic understanding:

```json
{
  "retrieval_mode": "vector",
  "top_k": 5,
  "score_threshold": 0.7
}
```

**Use cases**: Concept matching, understanding questions, semantic search

### Hybrid Search (Vector + Keyword)

Combines vector similarity with BM25 keyword matching:

```json
{
  "retrieval_mode": "hybrid",
  "hybrid_weights": {
    "vector_weight": 0.7,
    "keyword_weight": 0.3
  },
  "top_k": 5,
  "score_threshold": 0.7
}
```

**Weight recommendations**:
- **Conceptual queries** (0.8/0.2): Understanding, explanations
- **Balanced** (0.7/0.3): General purpose (default)
- **Precise matching** (0.3/0.7): Code search, API names, exact terms

## Using Retrievers with RAG

### 1. Upload and Index Documents

```bash
POST /api/rag/documents/upload
Content-Type: multipart/form-data

- knowledge_id: "kb_001"
- retriever_name: "my-es-retriever"
- retriever_namespace: "default"
- file: <document.pdf>
- embedding_config: {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key": "sk-..."
  }
```

**Supported file types**: MD, PDF, TXT, DOCX, and code files

### 2. Retrieve Relevant Chunks

```bash
POST /api/rag/retrieve
Content-Type: application/json

{
  "query": "How do I configure a bot?",
  "knowledge_id": "kb_001",
  "retriever_ref": {
    "name": "my-es-retriever",
    "namespace": "default"
  },
  "embedding_config": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key": "sk-..."
  },
  "top_k": 5,
  "score_threshold": 0.7,
  "retrieval_mode": "hybrid",
  "hybrid_weights": {
    "vector_weight": 0.7,
    "keyword_weight": 0.3
  }
}
```

### 3. Manage Documents

```bash
# List documents
GET /api/rag/documents?knowledge_id=kb_001&retriever_name=my-es-retriever&page=1&page_size=20

# Get document details
GET /api/rag/documents/{doc_ref}?knowledge_id=kb_001&retriever_name=my-es-retriever

# Delete document
DELETE /api/rag/documents/{doc_ref}?knowledge_id=kb_001&retriever_name=my-es-retriever
```

## Embedding Providers

### OpenAI

```json
{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "api_key": "sk-...",
  "base_url": "https://api.openai.com/v1"  // Optional
}
```

### Custom API (OpenAI-compatible)

```json
{
  "provider": "custom",
  "model": "your-model-name",
  "api_key": "your-api-key",
  "base_url": "https://your-api-endpoint.com/v1"
}
```

## Resource Scopes

Retrievers support three scopes:

| Scope | Description | Access |
|-------|-------------|--------|
| **Personal** | Your private retrievers | Only you |
| **Group** | Shared within a group | Group members |
| **Public** | System-provided retrievers | All users |

## Best Practices

### 1. Index Strategy Selection

- **Use `per_user`** for Elasticsearch (recommended)
- **Use `per_dataset`** for multi-tenant scenarios with dataset isolation
- **Avoid `fixed`** for production (only suitable for small, single-tenant deployments)

### 2. Retrieval Mode Selection

- **Vector mode**: Semantic understanding, concept matching
- **Hybrid mode**: Balanced semantic and exact matching (recommended for most use cases)
- **Adjust weights**: Based on query type (conceptual vs. precise)

### 3. Security

- Store credentials securely (use environment variables or secrets management)
- Use API keys instead of username/password when possible
- Restrict access using namespaces and groups

### 4. Performance

- Choose appropriate index strategy based on dataset size
- Monitor storage backend performance
- Use `per_user` mode for Elasticsearch to avoid index explosion
- Set appropriate `top_k` and `score_threshold` values

### 5. Document Management

- Use meaningful `knowledge_id` values for organization
- Regularly clean up unused documents
- Monitor storage usage

## Troubleshooting

### Connection Failed

**Problem**: Cannot connect to Elasticsearch

**Solutions**:
1. Verify Elasticsearch is running: `docker ps | grep elasticsearch`
2. Check URL is correct: `http://elasticsearch:9200` (internal) or `http://localhost:9200` (external)
3. Test connection: Use the **Test Connection** button in the UI
4. Check credentials: Verify username/password or API key

### Indexing Failed

**Problem**: Document upload fails

**Solutions**:
1. Check file format is supported (MD, PDF, TXT, DOCX, code files)
2. Verify embedding provider credentials
3. Check Elasticsearch storage capacity
4. Review backend logs for detailed error messages

### Low Retrieval Quality

**Problem**: Retrieved chunks are not relevant

**Solutions**:
1. Try hybrid mode instead of pure vector mode
2. Adjust hybrid weights based on query type
3. Lower `score_threshold` to get more results
4. Use a better embedding model (e.g., `text-embedding-3-large`)
5. Improve document chunking (automatic semantic chunking is used)

## API Reference

For complete API documentation, see:
- Backend API docs: `http://localhost:8000/api/docs`
- AGENTS.md: RAG Services section

## Related Documentation

- [Creating Bots](creating-bots.md)
- [Creating Teams](creating-teams.md)
- [Managing Tasks](managing-tasks.md)
- [YAML Specification](../../reference/yaml-specification.md)

## Feedback

Since RAG functionality is experimental, we welcome your feedback:
- Report issues on GitHub
- Suggest improvements
- Share your use cases

---

**Note**: This feature is under active development. Check the [changelog](../../../README.md) for updates.
