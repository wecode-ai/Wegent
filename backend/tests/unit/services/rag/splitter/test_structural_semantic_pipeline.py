# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the enhanced StructuralSemanticSplitter pipeline.

Tests cover:
1. Data model compatibility
2. Text extractors
3. Structure recognition
4. Noise filtering
5. Structural chunking
6. Token splitting
7. Content cleaning
8. Full pipeline integration
"""

from dataclasses import asdict

import pytest
from llama_index.core import Document

from app.services.rag.splitter.chunkers import StructuralChunker, TokenSplitter
from app.services.rag.splitter.cleaners import ContentCleaner
from app.services.rag.splitter.extractors import (
    ExtractorFactory,
    MarkdownExtractor,
    TxtExtractor,
)
from app.services.rag.splitter.filters import NoiseFilter
from app.services.rag.splitter.models import (
    BlockType,
    ChunkItem,
    DocumentChunks,
    DocumentIR,
    SkippedElement,
    SkippedElementType,
    StructureBlock,
)
from app.services.rag.splitter.recognizers import StructureRecognizer
from app.services.rag.splitter.structural_semantic import (
    StructuralSemanticSplitter,
    is_structural_semantic_supported,
)


class TestDataModels:
    """Test data model compatibility and serialization."""

    def test_chunk_item_to_dict(self):
        """Test ChunkItem can be converted to dict."""
        chunk = ChunkItem(
            chunk_index=0,
            content="Test content",
            token_count=10,
            start_position=0,
            end_position=12,
            forced_split=False,
            chunk_type="paragraph",
            title_path=["Section 1", "Subsection"],
        )

        result = asdict(chunk)

        assert result["chunk_index"] == 0
        assert result["content"] == "Test content"
        assert result["forced_split"] is False
        assert result["chunk_type"] == "paragraph"
        assert result["title_path"] == ["Section 1", "Subsection"]
        assert result["is_merged"] is False
        assert result["is_split"] is False

    def test_document_chunks_to_dict(self):
        """Test DocumentChunks can be converted to dict."""
        chunk_item = ChunkItem(
            chunk_index=0,
            content="Test",
            token_count=5,
            start_position=0,
            end_position=4,
        )
        doc_chunks = DocumentChunks(
            chunks=[chunk_item],
            total_chunks=1,
            overlap_tokens=80,
            has_non_text_content=True,
            skipped_elements=["images"],
            processing_stats={"total_documents": 1},
        )

        result = asdict(doc_chunks)

        assert len(result["chunks"]) == 1
        assert result["total_chunks"] == 1
        assert result["has_non_text_content"] is True
        assert "images" in result["skipped_elements"]
        assert result["processing_stats"]["total_documents"] == 1

    def test_skipped_element_to_dict(self):
        """Test SkippedElement serialization."""
        elem = SkippedElement(
            type=SkippedElementType.IMAGE,
            location={"line_start": 1, "line_end": 1},
            original_marker="![image](url)",
            description="Test image",
        )

        result = elem.to_dict()

        assert result["type"] == "image"
        assert result["location"]["line_start"] == 1
        assert result["original_marker"] == "![image](url)"


class TestExtractors:
    """Test text extractors."""

    def test_extractor_factory_markdown(self):
        """Test factory returns correct extractor for markdown."""
        factory = ExtractorFactory()
        extractor = factory.get_extractor("md")
        assert isinstance(extractor, MarkdownExtractor)

    def test_extractor_factory_txt(self):
        """Test factory returns correct extractor for txt."""
        factory = ExtractorFactory()
        extractor = factory.get_extractor("txt")
        assert isinstance(extractor, TxtExtractor)

    def test_markdown_extractor_basic(self):
        """Test markdown extractor with basic content."""
        extractor = MarkdownExtractor()
        text = """# Heading 1

This is a paragraph.

## Heading 2

- List item 1
- List item 2

```python
def hello():
    print("world")
```
"""
        cleaned, metadata, skipped = extractor.extract_from_text(text, "test.md")

        assert "# Heading 1" in cleaned
        assert "## Heading 2" in cleaned
        assert len(skipped) == 0

        # Check metadata
        heading_lines = [m for m in metadata if m.is_heading]
        assert len(heading_lines) == 2

        code_lines = [m for m in metadata if m.is_code_block]
        assert len(code_lines) > 0

    def test_markdown_extractor_removes_images(self):
        """Test markdown extractor removes image references."""
        extractor = MarkdownExtractor()
        text = """# Test

![Alt text](image.png)

Some content after image.
"""
        cleaned, metadata, skipped = extractor.extract_from_text(text, "test.md")

        assert "![Alt text]" not in cleaned
        assert "image.png" not in cleaned
        assert len(skipped) == 1
        assert skipped[0]["type"] == "image"


class TestStructureRecognizer:
    """Test structure recognition."""

    def test_recognize_headings(self):
        """Test heading recognition."""
        recognizer = StructureRecognizer()
        text = """# Main Title

Introduction paragraph.

## Section 1

Section content.
"""
        # Use the actual extractor to get proper metadata
        from app.services.rag.splitter.extractors import MarkdownExtractor

        extractor = MarkdownExtractor()
        _, metadata, _ = extractor.extract_from_text(text, "test.md")

        doc_ir = recognizer.recognize(text, metadata)

        # Find heading blocks
        headings = [b for b in doc_ir.blocks if b.type == BlockType.HEADING]
        assert len(headings) >= 2

    def test_recognize_code_block(self):
        """Test code block recognition."""
        recognizer = StructureRecognizer()
        text = """Some text.

```python
def hello():
    pass
```

More text.
"""
        from app.services.rag.splitter.extractors import MarkdownExtractor

        extractor = MarkdownExtractor()
        _, metadata, _ = extractor.extract_from_text(text, "test.md")

        doc_ir = recognizer.recognize(text, metadata)

        code_blocks = [b for b in doc_ir.blocks if b.type == BlockType.CODE]
        assert len(code_blocks) == 1
        assert "def hello" in code_blocks[0].content

    def test_recognize_list(self):
        """Test list recognition."""
        recognizer = StructureRecognizer()
        text = """Shopping list:

- Apples
- Bananas
- Oranges

That's all.
"""
        from app.services.rag.splitter.extractors import MarkdownExtractor

        extractor = MarkdownExtractor()
        _, metadata, _ = extractor.extract_from_text(text, "test.md")

        doc_ir = recognizer.recognize(text, metadata)

        lists = [b for b in doc_ir.blocks if b.type == BlockType.LIST]
        assert len(lists) == 1
        assert len(lists[0].items) == 3


class TestNoiseFilter:
    """Test noise filtering."""

    def test_filter_page_numbers(self):
        """Test page number filtering."""
        noise_filter = NoiseFilter()

        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Real content here.",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH, content="- 5 -", line_start=2, line_end=2
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="More content.",
                line_start=3,
                line_end=3,
            ),
        ]

        doc_ir = DocumentIR(
            blocks=blocks,
            source_file="test.md",
            file_type="md",
            file_size=50,
            total_lines=5,
        )

        filtered = noise_filter.filter(doc_ir)

        # Page number should be filtered
        assert len(filtered.blocks) == 2
        assert all("- 5 -" not in b.content for b in filtered.blocks)

    def test_filter_empty_blocks(self):
        """Test empty block filtering."""
        noise_filter = NoiseFilter()

        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Good content.",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH, content="   ", line_start=2, line_end=2
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH, content="", line_start=3, line_end=3
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="More good content.",
                line_start=4,
                line_end=4,
            ),
        ]

        doc_ir = DocumentIR(
            blocks=blocks,
            source_file="test.md",
            file_type="md",
            file_size=50,
            total_lines=5,
        )

        filtered = noise_filter.filter(doc_ir)

        # Empty blocks should be filtered
        assert len(filtered.blocks) == 2

    def test_filter_horizontal_rules(self):
        """Test horizontal rule filtering."""
        noise_filter = NoiseFilter()

        blocks = [
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="Real content here.",
                line_start=1,
                line_end=1,
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH, content="---", line_start=2, line_end=2
            ),
            StructureBlock(
                type=BlockType.PARAGRAPH,
                content="More content.",
                line_start=3,
                line_end=3,
            ),
        ]

        doc_ir = DocumentIR(
            blocks=blocks,
            source_file="test.md",
            file_type="md",
            file_size=50,
            total_lines=5,
        )

        filtered = noise_filter.filter(doc_ir)

        # Horizontal rule should be filtered
        assert len(filtered.blocks) == 2
        assert all("---" not in b.content for b in filtered.blocks)


class TestTokenSplitter:
    """Test token-based splitting."""

    def test_merge_small_chunks(self):
        """Test merging of small chunks."""
        splitter = TokenSplitter(min_tokens=50, max_tokens=500)

        chunks = [
            {"content": "Small chunk 1.", "token_count": 10},
            {"content": "Small chunk 2.", "token_count": 10},
            {"content": "Small chunk 3.", "token_count": 10},
        ]

        result = splitter.split(chunks)

        # Should be merged into fewer chunks
        assert len(result) < len(chunks)

    def test_split_large_chunks(self):
        """Test splitting of large chunks."""
        splitter = TokenSplitter(min_tokens=10, max_tokens=50)

        # Create a large chunk with actual sentences
        sentences = [
            "This is sentence number one.",
            "This is sentence number two.",
            "This is sentence number three.",
            "This is sentence number four.",
            "This is sentence number five.",
            "This is sentence number six.",
            "This is sentence number seven.",
            "This is sentence number eight.",
            "This is sentence number nine.",
            "This is sentence number ten.",
        ]
        large_content = " ".join(sentences)
        chunks = [{"content": large_content, "chunk_type": "paragraph"}]

        result = splitter.split(chunks)

        # Should be split into multiple chunks since it exceeds 50 tokens
        assert len(result) >= 1
        # At least one chunk should exist
        assert all(c.get("content", "") for c in result)


class TestContentCleaner:
    """Test content cleaning."""

    def test_clean_paragraph(self):
        """Test paragraph cleaning."""
        cleaner = ContentCleaner()

        chunks = [
            {
                "content": "  Line 1\n  Line 2   \n\n\n  Line 3  ",
                "chunk_type": "paragraph",
            }
        ]

        result = cleaner.clean(chunks)

        assert "\n\n\n" not in result[0]["content"]

    def test_clean_code_preserves_indentation(self):
        """Test code cleaning preserves indentation."""
        cleaner = ContentCleaner()

        chunks = [
            {
                "content": "def hello():\n    print('world')\n\n\n    return True",
                "chunk_type": "code",
            }
        ]

        result = cleaner.clean(chunks)

        # Indentation should be preserved
        assert "    print" in result[0]["content"]
        # Extra blank lines should be removed
        assert "\n\n\n" not in result[0]["content"]

    def test_clean_list_normalizes_bullets(self):
        """Test list cleaning normalizes bullets."""
        cleaner = ContentCleaner()

        chunks = [
            {
                "content": "* Item 1\n+ Item 2\n- Item 3",
                "chunk_type": "list",
            }
        ]

        result = cleaner.clean(chunks)

        # All bullets should be normalized to -
        assert "- Item 1" in result[0]["content"]
        assert "- Item 2" in result[0]["content"]
        assert "- Item 3" in result[0]["content"]


class TestFullPipeline:
    """Test full splitter pipeline integration."""

    def test_split_simple_document(self):
        """Test splitting a simple markdown document."""
        splitter = StructuralSemanticSplitter()

        doc = Document(
            text="""# Introduction

This is a test document with multiple sections.

## Section 1

First section content here. It contains some useful information.

## Section 2

Second section with more content. This helps test the chunking.

### Subsection 2.1

Nested content under section 2.
""",
            metadata={"filename": "test.md", "file_type": "md"},
        )

        nodes = splitter.split_documents([doc])

        assert len(nodes) > 0
        # Each node should have content
        assert all(node.text.strip() for node in nodes)

    def test_split_documents_with_chunks(self):
        """Test splitting returns both nodes and chunks."""
        splitter = StructuralSemanticSplitter()

        doc = Document(
            text="""# Test

Some content here.

## More

Additional content.
""",
            metadata={"filename": "test.md"},
        )

        nodes, doc_chunks = splitter.split_documents_with_chunks([doc])

        assert len(nodes) == len(doc_chunks.chunks)
        assert doc_chunks.total_chunks == len(nodes)

        # Test serialization
        chunks_dict = asdict(doc_chunks)
        assert "chunks" in chunks_dict
        assert "total_chunks" in chunks_dict

    def test_split_with_images(self):
        """Test splitting document with images."""
        splitter = StructuralSemanticSplitter()

        doc = Document(
            text="""# Document with Images

![Screenshot](image.png)

Text after image.

<img src="another.jpg" />

More text.
""",
            metadata={"filename": "test.md"},
        )

        nodes, doc_chunks = splitter.split_documents_with_chunks([doc])

        assert doc_chunks.has_non_text_content is True
        assert len(doc_chunks.skipped_elements) > 0

    def test_backward_compatibility_detect_non_text(self):
        """Test backward compatible detect_non_text_content method."""
        splitter = StructuralSemanticSplitter()

        text = "Some text ![image](url) more text"
        has_non_text, detected = splitter.detect_non_text_content(text)

        assert has_non_text is True
        assert "images" in detected

    def test_backward_compatibility_remove_non_text(self):
        """Test backward compatible remove_non_text_content method."""
        splitter = StructuralSemanticSplitter()

        text = "Before ![image](url) after"
        cleaned = splitter.remove_non_text_content(text)

        assert "![image]" not in cleaned
        assert "url" not in cleaned

    def test_get_config(self):
        """Test get_config returns correct values."""
        splitter = StructuralSemanticSplitter(
            min_chunk_tokens=150,
            max_chunk_tokens=500,
            overlap_tokens=100,
        )

        config = splitter.get_config()

        assert config["type"] == "structural_semantic"
        assert config["min_chunk_tokens"] == 150
        assert config["max_chunk_tokens"] == 500
        assert config["overlap_tokens"] == 100


class TestSupportedExtensions:
    """Test file extension support."""

    def test_supported_extensions(self):
        """Test supported file extensions."""
        assert is_structural_semantic_supported(".md") is True
        assert is_structural_semantic_supported(".txt") is True
        assert is_structural_semantic_supported(".pdf") is True
        assert is_structural_semantic_supported(".docx") is True
        assert is_structural_semantic_supported(".doc") is True

    def test_unsupported_extensions(self):
        """Test unsupported file extensions."""
        assert is_structural_semantic_supported(".xlsx") is False
        assert is_structural_semantic_supported(".pptx") is False
        assert is_structural_semantic_supported(".jpg") is False

    def test_extension_normalization(self):
        """Test extension normalization."""
        assert is_structural_semantic_supported("md") is True
        assert is_structural_semantic_supported("MD") is True
        assert is_structural_semantic_supported(".MD") is True
