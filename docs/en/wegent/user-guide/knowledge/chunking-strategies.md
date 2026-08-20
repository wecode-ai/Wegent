---
sidebar_position: 9
---

# Chunking Strategies

Chunking strategies determine how documents are split into smaller pieces for retrieval. Choosing the right chunking strategy can significantly improve retrieval quality.

---

## 📊 Strategy Overview

| Strategy | Best For | Description |
|----------|----------|-------------|
| **Smart Chunking** | General documents | Auto-detect document structure |
| **Sentence-based** | Precise retrieval | Split by sentence boundaries |
| **Semantic** | Complex documents | Split by semantic similarity |

---

## 🧠 Smart Chunking

Smart chunking is the default strategy that automatically identifies document structure and splits accordingly.

### How It Works

- Identifies paragraphs, headers, lists, and other structures
- Maintains semantic integrity
- Automatically adjusts chunk size

### Best For

- Structured documents (technical docs, reports)
- Mixed content documents
- Most general use cases

### Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `chunk_size` | Target chunk size (characters) | 500 |
| `chunk_overlap` | Overlap between chunks | 50 |

---

## 📝 Sentence-based Chunking

Sentence-based chunking splits documents by sentence boundaries, suitable for scenarios requiring precise retrieval.

### How It Works

- Identifies sentence boundaries (periods, question marks, exclamation marks)
- Combines adjacent sentences into chunks
- Maintains sentence integrity

### Best For

- FAQ documents
- Q&A content
- Scenarios requiring precise matching

### Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `separator` | Sentence separators | `.!?` |
| `buffer_size` | Sentence buffer count | 1 |

---

## 🔗 Semantic Chunking

Semantic chunking splits based on content semantic similarity, suitable for complex documents.

### How It Works

- Calculates semantic similarity between adjacent text
- Splits at semantic change points
- Maintains topic coherence

### Best For

- Long articles
- Documents with diverse topics
- Scenarios requiring context coherence

### Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `breakpoint_threshold` | Semantic breakpoint threshold | 0.5 |
| `buffer_size` | Context buffer size | 1 |

---

## 📑 Excel Files

Excel files (.xlsx) are always chunked by **whole rows**, regardless of the selected strategy: a row is the smallest semantic unit of a table and is never cut in half.

### How It Works

- Each worksheet is chunked independently, preserving the sheet name and physical row/column coordinates (newlines in sheet names are collapsed to spaces so they cannot forge row content)
- Multiple complete rows are packed into one chunk up to the chunk size limit
- A row exceeding the limit is split by cells; a single overlong cell value is split into coordinate-bearing fragments that can be fully reconstructed
- Character overlap (`chunk_overlap`) does not apply to Excel
- Formula cells index both the formula expression and its cached result (when the workbook was saved with one), so querying by either matches

### Notes

- Semantic chunking does not apply to Excel; files fall back to row-wise chunking
- `chunk_size` bounds both text forms of each chunk — the embedded text (readable rows plus the Worksheet context line) and the display text (canonical rows plus the sheet header); each prefix is paid out of the chunk size instead of being added on top (overlong sheet names are truncated with an ellipsis; real files are bounded by Excel's 31-character worksheet name limit). File-level origin is not part of the embedded text — it is carried by the file title in retrieval results and by document-scope filters
- Row data outranks context: near the minimum chunk budget, if keeping the sheet prefix would starve a cell fragment of room, the prefix is dropped to preserve data completeness (an empty sheet name also emits no prefix)
- With hierarchical chunking, both parent and child chunks pack whole rows
- Chunking follows the file's real content: whatever file type the knowledge base is configured with, files that are actually Excel are always chunked by rows. Workbooks with corrupted style data are retried once with styles skipped; any other unparseable corrupted workbook fails indexing explicitly rather than degrading silently

---

## ⚙️ General Configuration

### Chunk Size

Chunk size affects retrieval precision and recall:

| Size | Pros | Cons |
|------|------|------|
| **Small** (200-300) | Precise matching | May lose context |
| **Medium** (400-600) | Balance precision and context | General choice |
| **Large** (800-1000) | Preserve more context | May include irrelevant content |

### Chunk Overlap

Overlap prevents important information from being split:

- **No overlap** (0): Independent chunks, saves storage
- **Small overlap** (20-50): Basic continuity
- **Large overlap** (100+): Strong context preservation

---

## 💡 Selection Recommendations

### By Document Type

| Document Type | Recommended Strategy | Reason |
|---------------|---------------------|--------|
| Technical docs | Smart Chunking | Preserve structure |
| FAQ | Sentence-based | Precise Q&A matching |
| Long articles | Semantic | Maintain topic coherence |
| Code docs | Smart Chunking | Identify code blocks |

### By Use Case

| Scenario | Recommended Configuration |
|----------|--------------------------|
| Precise Q&A | Sentence-based + small chunks |
| Knowledge retrieval | Smart Chunking + medium chunks |
| Context understanding | Semantic + large chunks |

---

## 🔄 Re-chunking

If retrieval results are unsatisfactory, you can re-chunk:

1. Go to the knowledge base document list
2. Select documents to re-chunk
3. Click **Re-index**
4. Choose new chunking strategy and parameters
5. Confirm reprocessing

Re-chunking will delete old chunks and create new ones.

---

## 🔗 Related Documentation

- [User Guide](./knowledge-base-guide.md) - Complete knowledge base guide
- [Document Management](./document-management.md) - Adding and managing documents
- [Configuring Retrievers](./configuring-retrievers.md) - Retriever configuration guide
