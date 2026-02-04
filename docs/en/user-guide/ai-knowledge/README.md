---
sidebar_position: 4
---

# 📚 AI Knowledge

The AI Knowledge module provides document storage, organization, and retrieval capabilities, implementing RAG (Retrieval-Augmented Generation) to enable AI agents to answer questions based on your specific documents.

---

## 📋 Documents in This Module

| Document | Description |
|----------|-------------|
| [Knowledge Base Guide](./knowledge-base-guide.md) | Complete guide to using knowledge bases, including creation, document management, smart chunking, etc. |
| [Managing Knowledge Bases](./managing-knowledge-bases.md) | Creating, configuring, and managing knowledge bases |
| [Configuring Retrievers](./configuring-retrievers.md) | Configure RAG retrievers (Elasticsearch, Qdrant, etc.) |

---

## 🎯 Core Features

### Document Management

Support for multiple document sources and formats:

- **File Upload**: Support for PDF, Markdown, Word, TXT, and more
- **Text Paste**: Create text documents directly
- **Web Scraping**: Import content from URLs
- **External Tables**: Import DingTalk/Feishu tables

### Smart Chunking

Automatically split documents into optimal fragments for retrieval:

- **Markdown Files**: Split by headings and sentences
- **Text Files**: Split by sentence boundaries
- **PDF/Word**: Recursive character splitting

### RAG Retrieval

Support for multiple retrieval modes:

| Mode | Description | Use Case |
|------|-------------|----------|
| **Vector** | Semantic similarity search | Natural language queries |
| **Keyword** | Traditional BM25 text search | Exact term matching |
| **Hybrid** | Vector + Keyword combination | Best overall results |

### Citation Mechanism

AI responses include numbered citations linking to source documents:

```
According to your product documentation [1], the feature works by...
Additionally, the troubleshooting guide [2] suggests...

Sources:
[1] product-overview.pdf (Section 3)
[2] troubleshooting-guide.md (Chunk 15)
```

---

## 🚀 Quick Start

1. **Create Knowledge Base**: Go to the Knowledge Base page and click "Create Knowledge Base"
2. **Upload Documents**: Add your documents (PDF, Markdown, etc.)
3. **Configure Retrieval**: Select retriever and embedding model
4. **Start Chatting**: Select the knowledge base in chat and start asking questions

---

## 🔗 Related Resources

- [AI Chat](../ai-chat/README.md) - Use knowledge bases in conversations
- [Agent Settings](../settings/agent-settings.md) - Configure agents with knowledge base access
- [Core Concepts](../../concepts/core-concepts.md) - Understand Wegent architecture
