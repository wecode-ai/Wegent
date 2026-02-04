---
sidebar_position: 1
---

# Overview

AI Knowledge is Wegent's knowledge management feature that allows you to create and manage structured knowledge for AI agents to retrieve and reference during conversations.

---

## 📋 Core Concepts

### Knowledge Base

A **Knowledge Base** is a container for storing and managing knowledge:

- **Document Collection**: Contains multiple related documents
- **Vector Storage**: Document content converted to vectors for semantic retrieval
- **Access Control**: Supports private and public access

### Retrievers

A **Retriever** defines how to search for information in the knowledge base:

- **Semantic Retrieval**: Intelligent retrieval based on vector similarity
- **Keyword Retrieval**: Traditional keyword matching
- **Hybrid Retrieval**: Combines the advantages of both approaches

```
Knowledge Base = Document Collection + Vectorization + Metadata
Retriever = Retrieval Strategy + Relevance Algorithm + Result Ranking
```

---

## 🎯 Main Features

### 1. Knowledge Base Management

Create and manage knowledge bases:

- Create multiple knowledge bases
- Upload and manage documents
- Automatic document chunking and processing
- View processing status and statistics

### 2. Document Support

Supports multiple document formats and data sources:

| Format | Description |
|--------|-------------|
| **Markdown** | Recommended, preserves formatting and structure |
| **PDF** | Automatic text extraction |
| **Word** | Supports .docx format |
| **Plain Text** | .txt files |
| **Web Scraping** | Automatically scrape content from URLs |

#### Web Scraping

Supports direct content scraping from web pages:

- Enter a URL to automatically scrape
- Intelligent extraction of main content
- Support for dynamic page rendering
- Automatic handling of paginated content

### 3. Retrieval Configuration

Flexible configuration of retrieval behavior:

- Choose retrieval strategy (semantic/keyword/hybrid)
- Set number of returned results
- Configure relevance threshold
- Customize chunk size

### 4. Knowledge Base Application

Associate knowledge bases with agents:

- Select knowledge bases in agent configuration
- Automatic retrieval of relevant knowledge during conversations
- View citation sources

---

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| [Knowledge Base Guide](./knowledge-base-guide.md) | Creating and managing knowledge bases |
| [Configuring Retrievers](./configuring-retrievers.md) | Setting retrieval strategies and parameters |

---

## 🚀 Quick Start

### Create Your First Knowledge Base

1. Navigate to the **Knowledge** page
2. Click **New Knowledge Base**
3. Fill in knowledge base information:
   - Name: e.g., "Product Documentation"
   - Description: Purpose of the knowledge base
4. Upload document files
5. Wait for document processing to complete

### Configure Retrievers

1. Enter knowledge base details
2. Click **Retrieval Settings**
3. Select retrieval strategy:
   - Semantic: Suitable for conceptual questions
   - Keyword: Suitable for exact matching
   - Hybrid: Balances both approaches
4. Adjust parameters and save

### Use in Agents

1. Go to agent settings
2. Select created knowledge bases in the knowledge base options
3. Save configuration
4. Conversations with this agent will automatically reference knowledge base content

---

## 💡 Use Cases

### Product Documentation

- **User Manuals**: Store product usage instructions
- **FAQ Collections**: Common questions and answers
- **Release Notes**: Product update logs

### Technical Documentation

- **API Documentation**: Interface definitions and usage examples
- **Architecture Docs**: System design documentation
- **Best Practices**: Team experience summaries

### Enterprise Knowledge

- **Policies**: Company internal regulations
- **Training Materials**: Employee training documents
- **Project Documentation**: Historical project archives

---

## 🔗 Related Resources

- [Agent Settings](../settings/agent-settings.md) - Configure agents that use knowledge bases
- [Chat Overview](../chat/README.md) - Use knowledge bases in conversations
