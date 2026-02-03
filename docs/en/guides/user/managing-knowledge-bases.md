# Managing Knowledge Bases

English | [简体中文](../../zh/guides/user/managing-knowledge-bases.md)

> ⚠️ **EXPERIMENTAL FEATURE**: The Knowledge Base functionality is currently under active development. Features and behaviors may change in future releases.

## Overview

Knowledge Bases in Wegent allow you to store documents and let AI reference them during conversations. This guide covers creating, managing, and using knowledge bases effectively.

## Knowledge Base Types

Wegent supports two types of knowledge bases:

### Notebook Mode

- **Use Case**: Interactive document exploration and Q&A
- **Features**:
  - Three-column layout with document panel and chat area
  - Direct conversations within the knowledge base
  - Maximum 50 documents per knowledge base
  - Best for focused research and document analysis

### Classic Mode

- **Use Case**: Large document repositories referenced in chats
- **Features**:
  - Document list only (no built-in chat)
  - No document count limit
  - Referenced from Chat or Code conversations
  - Best for extensive documentation libraries

## Creating a Knowledge Base

### With RAG (Recommended)

When you have a retriever and embedding model configured:

1. Navigate to **Knowledge** → **Document Knowledge**
2. Click **Create Knowledge Base** or **Create Notebook**
3. Fill in:
   - **Name**: Unique identifier for your knowledge base
   - **Description**: Optional description
   - **Type**: Notebook or Classic
4. Configure retrieval settings:
   - **Retriever**: Select configured retriever (e.g., Elasticsearch)
   - **Embedding Model**: Select model for vector generation
   - **Retrieval Mode**: Vector, Keyword, or Hybrid
   - **Top K**: Number of results (1-10)
   - **Score Threshold**: Minimum similarity score (0-1)
5. Click **Create**

### Without RAG (Exploration Mode)

When no retriever or embedding model is available:

1. Navigate to **Knowledge** → **Document Knowledge**
2. Click **Create Knowledge Base** or **Create Notebook**
3. Fill in basic information (Name, Description, Type)
4. The retrieval settings will be disabled with a warning
5. Click **Create**

> **Note**: In exploration mode, AI uses `kb_ls` and `kb_head` tools instead of semantic search. See [Using Knowledge Base Without RAG](configuring-retrievers.md#using-knowledge-base-without-rag-no-retriever-mode) for details.

## Document Management

### Uploading Documents

1. Open your knowledge base
2. Click **Add sources**
3. Choose source type:
   - **File**: Upload local files (MD, PDF, TXT, DOCX, code files)
   - **Text**: Create text documents directly
   - **Web**: Import from URL

### Supported Formats

| Format | Description | Best For |
|--------|-------------|----------|
| `.md` | Markdown files | Documentation, notes |
| `.pdf` | PDF documents | Reports, papers |
| `.txt` | Plain text | Simple documents |
| `.docx` | Word documents | Formatted content |
| Code files | `.py`, `.js`, `.ts`, etc. | Code documentation |

### Document Summaries

When enabled, Wegent can auto-generate summaries for documents:

1. Enable **Auto-generate Summary** in knowledge base settings
2. Select a summary model
3. Summaries help AI quickly identify relevant documents

### Document Status

- **Enabled**: Document is active and searchable
- **Disabled**: Document is stored but not used in searches
- **Indexing**: Document is being processed for RAG (if configured)

## AI Tools for Knowledge Bases

### knowledge_base_search (RAG Mode)

Semantic search tool that finds relevant document chunks:

```text
Input: query string
Output: Relevant chunks with scores and sources
```

**Requires**: Retriever and Embedding Model configured

### kb_ls - List Documents

Lists all documents in a knowledge base with metadata:

```text
Input: knowledge_base_id
Output: List of documents with:
  - ID, name, file extension
  - File size
  - Short summary (if available)
  - Active status
```

**Works in**: Both RAG and No-RAG modes

### kb_head - Read Document Content

Reads document content with pagination support:

```text
Input: document_ids, offset (default 0), limit (default 50KB)
Output:
  - Document content
  - Total length
  - has_more flag for pagination
```

**Works in**: Both RAG and No-RAG modes

## Using Knowledge Bases in Conversations

### In Chat

1. Start a new chat or open existing conversation
2. Click the knowledge base icon in the input area
3. Select one or more knowledge bases
4. AI will search the selected knowledge bases when answering

### In Notebook Mode

1. Open a notebook-type knowledge base
2. Use the built-in chat panel on the right
3. AI automatically references all documents in the notebook

### Selection Modes

| Mode | When | AI Behavior |
|------|------|-------------|
| **Strict** | User selects KB for current message | Must use KB, cannot use general knowledge |
| **Relaxed** | KB inherited from task | Can fallback to general knowledge |

## Call Limits

Knowledge bases support call limits to manage API costs:

- **Max Calls Per Conversation**: Maximum tool calls allowed
- **Exempt Calls Before Check**: Initial calls without restrictions

Configure these in the knowledge base advanced settings.

## Best Practices

### Organizing Documents

1. **Group related documents** in the same knowledge base
2. **Use descriptive names** for easy identification
3. **Enable summaries** for faster document discovery
4. **Keep notebook KBs focused** (under 50 documents)

### Choosing RAG vs Exploration Mode

| Choose RAG When | Choose Exploration When |
|-----------------|------------------------|
| Large document collections | Small collections (<50 docs) |
| Need semantic search | Testing without infrastructure |
| High query volume | Avoiding embedding costs |
| Complex multi-document queries | Simple document lookup |

### Performance Tips

1. **Use hybrid search** for best accuracy
2. **Adjust score threshold** based on result quality
3. **Enable document summaries** for better exploration
4. **Use specific queries** rather than broad ones

## Troubleshooting

### Documents Not Showing in Search

1. Check document is **Enabled**
2. Verify RAG indexing completed (check status)
3. Try lowering **Score Threshold**
4. Use different search terms

### AI Not Using Knowledge Base

1. Verify knowledge base is selected
2. Check if strict/relaxed mode is appropriate
3. Review the query - is it related to KB content?
4. Check call limits haven't been exceeded

### Slow Search Performance

1. Consider reducing **Top K** value
2. Use **Vector** mode instead of **Hybrid** if keyword matching isn't needed
3. Check retriever service health

## Related Documentation

- [Configuring Retrievers](configuring-retrievers.md)
- [Agent Settings](agent-settings.md)
- [Managing Tasks](managing-tasks.md)

---

**Note**: Knowledge Base features are under active development. Check the [changelog](../../../README.md) for updates.
