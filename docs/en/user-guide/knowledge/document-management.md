---
sidebar_position: 8
---

# Document Management

Document management is a core feature of Knowledge Base, supporting multiple document sources and formats.

---

## 📥 Adding Documents

### Supported Document Sources

| Source | Description |
|--------|-------------|
| **File Upload** | Upload files from local computer |
| **Text Paste** | Paste text content directly |
| **External Table** | Import from DingTalk/Feishu tables |
| **Web Scraping** | Scrape content from URL |

### File Upload

1. Click **Add Document** → **Upload File**
2. Select file(s) from your computer
3. Configure chunking settings (optional)
4. Click **Upload**

Supported formats:
- `.txt` - Plain text files
- `.md` - Markdown files
- `.pdf` - PDF documents
- `.doc`, `.docx` - Word documents

### Text Paste

1. Click **Add Document** → **Paste Text**
2. Enter document title
3. Paste or type content
4. Click **Save**

Suitable for quickly creating small documents.

### External Table

1. Click **Add Document** → **External Table**
2. Enter table URL (DingTalk/Feishu)
3. Configure sync settings
4. Click **Import**

Supports importing data from online table services.

### Web Scraping

1. Click **Add Document** → **Web URL**
2. Enter the webpage URL
3. System scrapes and processes content
4. Click **Import**

Web documents support re-scraping for updates. When webpage content changes, use the refresh feature to get the latest content.

---

## 📋 Document List

### List Features

- **Search**: Search documents by name
- **Sort**: Sort by name, size, or date
- **Filter**: Filter documents by status

### Document Status

| Status | Description |
|--------|-------------|
| **Enabled** | Document is indexed and searchable |
| **Disabled** | Document exists but excluded from search |
| **Processing** | Document is being indexed |
| **Error** | Indexing failed |

---

## ✏️ Management Operations

### Basic Operations

| Operation | Description |
|-----------|-------------|
| **View Details** | View document content and metadata |
| **Edit** | Modify document name and settings |
| **Enable/Disable** | Toggle document search participation |
| **Re-index** | Reprocess document with new settings |
| **Delete** | Remove document permanently |
| **View Chunks** | Inspect how document was split |

### Batch Operations

Support multi-select for batch operations:

1. Use checkboxes to select multiple documents
2. Click **Select All** to select all documents
3. Click **Batch Delete** to delete selected documents

---

## 📌 Document Selection in Notebook Mode

In Notebook mode, the document list supports selection features:

### Selection Features

- **Select Specific Documents**: Check documents to include in context
- **Select All / Deselect All**: Quickly select or deselect all documents
- **Auto-selection**: Newly uploaded documents are automatically selected

### Context Injection

Selected documents are provided as context to the AI during conversations, helping the AI better understand and answer questions.

---

## 🔍 Document Editing

### Editable Content

- **Document Name**: Modify the display name
- **Chunking Settings**: Adjust document chunking strategy
- **Enable Status**: Control whether document participates in retrieval

### Editing Limitations

- **Source Type**: Cannot change document source type
- **File Content**: File-type document content cannot be directly edited
- **Table URL**: External table URLs cannot be directly modified

---

## 🔄 Web Document Refresh

Web documents support re-scraping:

1. Find the web document in the document list
2. Click the **Refresh** button
3. System will re-scrape the webpage content
4. Updated content will be automatically re-indexed

Suitable for tracking frequently updated web content.

---

## 💡 Best Practices

### Document Organization

| Practice | Description |
|----------|-------------|
| **Meaningful names** | Use descriptive document names |
| **Consistent format** | Standardize document formatting |
| **Regular updates** | Re-index when documents change |
| **Clean content** | Remove irrelevant headers/footers |

### Document Size

- Single file recommended not to exceed 50MB
- Large documents can be split into multiple smaller documents
- Text documents are easier to process than scanned PDFs

---

## 🔗 Related Documentation

- [User Guide](./knowledge-base-guide.md) - Complete knowledge base guide
- [Chunking Strategies](./chunking-strategies.md) - Learn how documents are split
