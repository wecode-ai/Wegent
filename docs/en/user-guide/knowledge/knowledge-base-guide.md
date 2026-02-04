---
sidebar_position: 6
---

# Knowledge Base Guide

Knowledge Base enables you to store, organize, and retrieve documents for RAG (Retrieval-Augmented Generation), allowing AI agents to answer questions based on your specific documents.

---

## 🎯 Overview

### What is Knowledge Base?

Knowledge Base is a document storage and retrieval system that enables RAG. It allows AI agents to search through your documents and provide answers grounded in your specific content.

### Core Benefits

| Benefit | Description |
|---------|-------------|
| **Grounded Responses** | AI answers based on your documents |
| **Source Citations** | Every answer includes references to source documents |
| **Smart Chunking** | Automatic document splitting optimized for retrieval |
| **Flexible Retrieval** | Vector, keyword, or hybrid search modes |

---

## 🆕 Creating Knowledge Bases

### Step 1: Navigate to Knowledge Base

1. Log in to Wegent
2. Navigate to **Knowledge Base** section in the sidebar
3. Click **Create Knowledge Base**

### Step 2: Choose Knowledge Base Type

| Type | Document Limit | Chat Support | Best For |
|------|----------------|--------------|----------|
| **Notebook** | 50 documents | ✅ Yes | Interactive research, Q&A sessions |
| **Classic** | Unlimited | ❌ No | Large document collections, archives |

See [Knowledge Base Types](./knowledge-base-types.md) for detailed comparison.

### Step 3: Configure Basic Settings

| Field | Description | Example |
|-------|-------------|---------|
| **Name** | Display name (1-100 chars) | "Product Documentation" |
| **Description** | Optional description (max 500 chars) | "Internal product docs and guides" |

### Step 4: Configure Retrieval Settings

| Setting | Options | Description |
|---------|---------|-------------|
| **Retrieval Mode** | Vector / Keyword / Hybrid | Search method |
| **top_k** | 1-10 (default: 5) | Number of results |
| **score_threshold** | 0.0-1.0 (default: 0.7) | Minimum relevance score |

### Step 5: Upload Documents

1. Click **Add Document**
2. Choose source type (File / Text / URL / External Table)
3. Configure chunking settings (optional)
4. Click **Upload**

---

## 📄 Document Management

### Supported Sources

| Source | Description |
|--------|-------------|
| **File Upload** | Upload from local computer |
| **Text Paste** | Paste text content directly |
| **External Table** | Import from DingTalk/Feishu |
| **Web Scraping** | Scrape content from URL |

### Supported Formats

- `.txt` - Plain text files
- `.md` - Markdown files
- `.pdf` - PDF documents
- `.doc`, `.docx` - Word documents

See [Document Management](./document-management.md) for detailed guide.

---

## 🔪 Chunking Strategies

### Available Strategies

| Strategy | Best For | Description |
|----------|----------|-------------|
| **Smart Chunking** | General documents | Auto-detect structure |
| **Sentence-based** | FAQ, Q&A content | Split by sentence boundaries |
| **Semantic** | Long articles | Split by semantic similarity |

### Key Parameters

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| **chunk_size** | 128-8192 | 500 | Characters per chunk |
| **chunk_overlap** | 0-2048 | 50 | Overlapping characters |

See [Chunking Strategies](./chunking-strategies.md) for detailed guide.

---

## 🔍 Retrieval Test

Before saving retrieval configuration, you can test the retrieval effectiveness.

### How to Use

1. Go to Knowledge Base **Retrieval Settings**
2. Configure retrieval parameters
3. Enter a test query in the **Retrieval Test** area
4. Click **Test** button
5. Review returned chunks and relevance scores
6. Adjust parameters based on results
7. Click **Save** when satisfied

---

## 📝 Summary Features

### Document Summaries

When enabled, the system automatically generates summaries for each document:

1. Document is uploaded and indexed
2. Summary model processes content
3. Summary stored with document metadata
4. Available for quick reference

### Knowledge Base Summary

Generate an aggregate summary of the entire Knowledge Base:

1. Navigate to Knowledge Base settings
2. Click **Generate Summary**
3. View combined summary of all documents

### Summary Retry

If summary generation fails:

1. Find the document with failed summary
2. Click **Retry Summary** button
3. System will attempt to regenerate

---

## 🤖 Integration with Agents

### Selecting Knowledge Base in Chat

1. Click the **context selector** near the chat input
2. Select **Knowledge Base** from options
3. Choose your desired Knowledge Base
4. Send your question

### Notebook Mode Chat

In Notebook mode, you can chat directly within the Knowledge Base:

1. Open a Notebook-type Knowledge Base
2. Use the chat panel on the right
3. Select specific documents for context (optional)
4. Ask questions about your documents

---

## 📑 Citations and References

### Citation Format

AI responses include numbered citations linking to source documents:

```
Based on your product documentation [1], the feature works by...
Additionally, the troubleshooting guide [2] suggests...

Sources:
[1] product-overview.pdf (Section 3)
[2] troubleshooting-guide.md (Chunk 15)
```

### Viewing Source Content

1. Click on a citation number in the response
2. View the original chunk content
3. See surrounding context
4. Navigate to full document if needed

---

## ❓ Troubleshooting

### Upload Issues

| Problem | Solution |
|---------|----------|
| File upload fails | Check file size (max 50MB) and format |
| Document stuck in "Processing" | Wait for large documents or re-upload |

### Retrieval Issues

| Problem | Solution |
|---------|----------|
| No results returned | Lower score_threshold or try different query |
| Irrelevant results | Reduce chunk_size or try hybrid mode |

---

## 💡 Best Practices

### Document Organization

| Practice | Description |
|----------|-------------|
| **Meaningful names** | Use descriptive document names |
| **Consistent format** | Standardize document formatting |
| **Regular updates** | Re-index when documents change |
| **Clean content** | Remove irrelevant headers/footers |

### Retrieval Tuning

| Scenario | Mode | top_k | threshold |
|----------|------|-------|-----------|
| Precise answers | Vector | 3-5 | 0.8 |
| Broad search | Hybrid | 8-10 | 0.6 |
| Exact matching | Keyword | 5 | 0.7 |

---

## 🔗 Related Resources

- [Knowledge Base Types](./knowledge-base-types.md) - Notebook vs Classic comparison
- [Document Management](./document-management.md) - Adding and managing documents
- [Chunking Strategies](./chunking-strategies.md) - Document chunking options
- [Configuring Retrievers](./configuring-retrievers.md) - Retrieval configuration
