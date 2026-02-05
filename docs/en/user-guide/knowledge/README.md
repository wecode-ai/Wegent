---
sidebar_position: 1
---

# Overview

AI Knowledge is Wegent's knowledge management feature that allows you to create and manage structured knowledge for AI agents to retrieve and reference during conversations.

<img src="https://github.com/user-attachments/assets/2b210d33-2569-4bc9-acac-e163de4e12a5" width="100%" alt="Knowledge Demo"/>

---

## 📋 Core Concepts

### Knowledge Base

A **Knowledge Base** is a container for storing and managing knowledge:

- **Document Collection**: Contains multiple related documents
- **Vector Storage**: Document content converted to vectors for semantic retrieval
- **Access Control**: Supports private and public access

### Knowledge Base Types

Wegent provides two types of knowledge bases:

| Type | Document Limit | Chat Support | Best For |
|------|----------------|--------------|----------|
| **Notebook** | 50 documents | ✅ Yes | Small knowledge bases, interactive Q&A |
| **Classic** | Unlimited | ❌ No | Large document libraries, batch retrieval |

### Retrievers

A **Retriever** defines how to search for information in the knowledge base:

- **Semantic Retrieval**: Intelligent retrieval based on vector similarity
- **Keyword Retrieval**: Traditional keyword matching
- **Hybrid Retrieval**: Combines the advantages of both approaches

---

## 🎯 Main Features

### 1. Knowledge Base Management

- Create multiple knowledge bases
- Choose knowledge base type (Notebook/Classic)
- Upload and manage documents
- Automatic document chunking and processing
- View processing status and statistics

### 2. Document Support

Supports multiple document formats and data sources:

| Source | Description |
|--------|-------------|
| **File Upload** | Supports Markdown, PDF, Word, plain text |
| **Text Paste** | Paste text content directly |
| **External Table** | Import from DingTalk/Feishu tables |
| **Web Scraping** | Automatically scrape content from URLs |

### 3. Chunking Strategies

Flexible document chunking options:

| Strategy | Best For |
|----------|----------|
| **Smart Chunking** | General documents, auto-detect structure |
| **Sentence-based** | FAQ, Q&A content, precise matching |
| **Semantic** | Long articles, maintain topic coherence |

### 4. Retrieval Configuration

- Choose retrieval strategy (semantic/keyword/hybrid)
- Set number of returned results
- Configure relevance threshold
- Retrieval test feature

### 5. Summary Features

- Document-level summaries: Auto-generate document summaries
- Knowledge base-level summaries: Overall knowledge base overview
- Summary retry: Retry when generation fails

---

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| [User Guide](./knowledge-base-guide.md) | Complete knowledge base guide |
| [Knowledge Base Types](./knowledge-base-types.md) | Notebook vs Classic comparison |
| [Document Management](./document-management.md) | Adding and managing documents |
| [Chunking Strategies](./chunking-strategies.md) | Document chunking strategies |
| [Configuring Retrievers](./configuring-retrievers.md) | Retrieval strategy and parameter configuration |

---

## 🚀 Quick Start

### Create Your First Knowledge Base

1. Navigate to the **Knowledge** page
2. Click **New Knowledge Base**
3. Choose knowledge base type:
   - **Notebook**: For small knowledge bases, supports chat
   - **Classic**: For large document libraries
4. Fill in name and description
5. Upload document files
6. Wait for document processing to complete

### Configure Retrievers

1. Enter knowledge base details
2. Click **Retrieval Settings**
3. Select retrieval strategy:
   - Semantic: Suitable for conceptual questions
   - Keyword: Suitable for exact matching
   - Hybrid: Balances both approaches
4. Use **Retrieval Test** to verify effectiveness
5. Adjust parameters and save

### Use in Agents

1. Go to agent settings
2. Select created knowledge bases in the knowledge base options
3. Save configuration
4. Conversations with this agent will automatically reference knowledge base content

---

## 💡 Use Cases

### Product Documentation

- **User Manuals**: Store product usage instructions
- **FAQ Collections**: Common questions and answers (Notebook recommended)
- **Release Notes**: Product update logs

### Technical Documentation

- **API Documentation**: Interface definitions and usage examples
- **Architecture Docs**: System design documentation
- **Best Practices**: Team experience summaries

### Enterprise Knowledge

- **Policies**: Company internal regulations
- **Training Materials**: Employee training documents (Notebook recommended)
- **Project Documentation**: Historical project archives (Classic recommended)

---

## 🔗 Related Resources

- [Agent Settings](../settings/agent-settings.md) - Configure agents that use knowledge bases
- [Chat Overview](../chat/README.md) - Use knowledge bases in conversations
