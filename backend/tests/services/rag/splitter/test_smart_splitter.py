# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for SmartSplitter."""

import pytest
from llama_index.core import Document

from app.services.rag.splitter.smart import (
    DOCX_CHUNK_OVERLAP,
    DOCX_CHUNK_SIZE,
    MD_CHUNK_OVERLAP,
    MD_CHUNK_SIZE,
    PDF_CHUNK_OVERLAP,
    PDF_CHUNK_SIZE,
    SMART_SUPPORTED_EXTENSIONS,
    TXT_CHUNK_OVERLAP,
    TXT_CHUNK_SIZE,
    SmartSplitter,
    is_smart_splitter_supported,
)


class TestSmartSplitterSupport:
    """Test is_smart_splitter_supported function."""

    def test_supported_extensions(self):
        """Test that all supported extensions return True."""
        assert is_smart_splitter_supported(".md") is True
        assert is_smart_splitter_supported(".txt") is True
        assert is_smart_splitter_supported(".pdf") is True
        assert is_smart_splitter_supported(".docx") is True
        assert is_smart_splitter_supported(".doc") is True

    def test_supported_extensions_without_dot(self):
        """Test that extensions without dot are also supported."""
        assert is_smart_splitter_supported("md") is True
        assert is_smart_splitter_supported("txt") is True
        assert is_smart_splitter_supported("pdf") is True
        assert is_smart_splitter_supported("docx") is True
        assert is_smart_splitter_supported("doc") is True

    def test_unsupported_extensions(self):
        """Test that unsupported extensions return False."""
        assert is_smart_splitter_supported(".xlsx") is False
        assert is_smart_splitter_supported(".pptx") is False
        assert is_smart_splitter_supported(".csv") is False
        assert is_smart_splitter_supported(".json") is False

    def test_case_insensitive(self):
        """Test that extension check is case insensitive."""
        assert is_smart_splitter_supported(".MD") is True
        assert is_smart_splitter_supported(".TXT") is True
        assert is_smart_splitter_supported(".PDF") is True
        assert is_smart_splitter_supported(".DOCX") is True


class TestSmartSplitterInit:
    """Test SmartSplitter initialization."""

    def test_init_markdown(self):
        """Test initialization for markdown files."""
        splitter = SmartSplitter(".md")
        assert splitter.file_extension == ".md"
        assert splitter.splitter_subtype == "markdown_sentence"
        assert hasattr(splitter, "markdown_parser")
        assert hasattr(splitter, "sentence_splitter")

    def test_init_txt(self):
        """Test initialization for txt files."""
        splitter = SmartSplitter(".txt")
        assert splitter.file_extension == ".txt"
        assert splitter.splitter_subtype == "token"
        assert hasattr(splitter, "splitter")

    def test_init_pdf(self):
        """Test initialization for PDF files."""
        splitter = SmartSplitter(".pdf")
        assert splitter.file_extension == ".pdf"
        assert splitter.splitter_subtype == "recursive_character"
        assert hasattr(splitter, "langchain_splitter")

    def test_init_docx(self):
        """Test initialization for DOCX files."""
        splitter = SmartSplitter(".docx")
        assert splitter.file_extension == ".docx"
        assert splitter.splitter_subtype == "recursive_character"
        assert hasattr(splitter, "langchain_splitter")

    def test_init_doc(self):
        """Test initialization for DOC files."""
        splitter = SmartSplitter(".doc")
        assert splitter.file_extension == ".doc"
        assert splitter.splitter_subtype == "recursive_character"
        assert hasattr(splitter, "langchain_splitter")

    def test_init_without_dot(self):
        """Test initialization with extension without dot."""
        splitter = SmartSplitter("pdf")
        assert splitter.file_extension == ".pdf"
        assert splitter.splitter_subtype == "recursive_character"

    def test_init_unsupported(self):
        """Test initialization with unsupported extension raises error."""
        with pytest.raises(ValueError) as exc_info:
            SmartSplitter(".xlsx")
        assert "Smart splitter not supported" in str(exc_info.value)
        assert ".xlsx" in str(exc_info.value)


class TestSmartSplitterConfig:
    """Test SmartSplitter get_config method."""

    def test_config_markdown(self):
        """Test config for markdown files."""
        splitter = SmartSplitter(".md")
        config = splitter.get_config()
        assert config["type"] == "smart"
        assert config["file_extension"] == ".md"
        assert config["splitter_subtype"] == "markdown_sentence"
        assert config["chunk_size"] == MD_CHUNK_SIZE
        assert config["chunk_overlap"] == MD_CHUNK_OVERLAP

    def test_config_txt(self):
        """Test config for txt files."""
        splitter = SmartSplitter(".txt")
        config = splitter.get_config()
        assert config["type"] == "smart"
        assert config["file_extension"] == ".txt"
        assert config["splitter_subtype"] == "token"
        assert config["chunk_size"] == TXT_CHUNK_SIZE
        assert config["chunk_overlap"] == TXT_CHUNK_OVERLAP

    def test_config_pdf(self):
        """Test config for PDF files."""
        splitter = SmartSplitter(".pdf")
        config = splitter.get_config()
        assert config["type"] == "smart"
        assert config["file_extension"] == ".pdf"
        assert config["splitter_subtype"] == "recursive_character"
        assert config["chunk_size"] == PDF_CHUNK_SIZE
        assert config["chunk_overlap"] == PDF_CHUNK_OVERLAP

    def test_config_docx(self):
        """Test config for DOCX files."""
        splitter = SmartSplitter(".docx")
        config = splitter.get_config()
        assert config["type"] == "smart"
        assert config["file_extension"] == ".docx"
        assert config["splitter_subtype"] == "recursive_character"
        assert config["chunk_size"] == DOCX_CHUNK_SIZE
        assert config["chunk_overlap"] == DOCX_CHUNK_OVERLAP


class TestSmartSplitterSplitDocuments:
    """Test SmartSplitter split_documents method."""

    def test_split_txt_documents(self):
        """Test splitting TXT documents."""
        splitter = SmartSplitter(".txt")
        # Create a document with enough content to be split
        content = "This is a test document. " * 100
        documents = [Document(text=content)]

        nodes = splitter.split_documents(documents)

        assert len(nodes) > 0
        for node in nodes:
            assert node.get_content().strip() != ""

    def test_split_markdown_documents(self):
        """Test splitting markdown documents."""
        splitter = SmartSplitter(".md")
        content = """# Chapter 1

This is the first chapter content. It has some text here.

## Section 1.1

This is section 1.1 with more content.

# Chapter 2

This is the second chapter with different content.
""" * 20  # Repeat to ensure splitting
        documents = [Document(text=content)]

        nodes = splitter.split_documents(documents)

        assert len(nodes) > 0
        for node in nodes:
            assert node.get_content().strip() != ""

    def test_split_pdf_documents(self):
        """Test splitting PDF documents (using text content)."""
        splitter = SmartSplitter(".pdf")
        # Simulate extracted PDF content
        content = "This is extracted PDF content. " * 200
        documents = [Document(text=content)]

        nodes = splitter.split_documents(documents)

        assert len(nodes) > 0
        for node in nodes:
            assert node.get_content().strip() != ""

    def test_split_docx_documents(self):
        """Test splitting DOCX documents (using text content)."""
        splitter = SmartSplitter(".docx")
        # Simulate extracted DOCX content
        content = "This is extracted Word document content. " * 200
        documents = [Document(text=content)]

        nodes = splitter.split_documents(documents)

        assert len(nodes) > 0
        for node in nodes:
            assert node.get_content().strip() != ""

    def test_split_empty_document(self):
        """Test splitting empty document."""
        splitter = SmartSplitter(".pdf")
        documents = [Document(text="")]

        nodes = splitter.split_documents(documents)

        assert len(nodes) == 0

    def test_split_preserves_metadata(self):
        """Test that metadata is preserved during splitting."""
        splitter = SmartSplitter(".pdf")
        content = "This is test content for metadata preservation. " * 200
        metadata = {"source": "test.pdf", "page": 1}
        documents = [Document(text=content, metadata=metadata)]

        nodes = splitter.split_documents(documents)

        assert len(nodes) > 0
        for node in nodes:
            assert "source" in node.metadata
            assert node.metadata["source"] == "test.pdf"


class TestSmartSplitterWithChunks:
    """Test SmartSplitter split_documents_with_chunks method."""

    def test_split_with_chunks_returns_tuple(self):
        """Test that split_documents_with_chunks returns correct tuple."""
        splitter = SmartSplitter(".txt")
        content = "This is test content. " * 100
        documents = [Document(text=content)]

        nodes, chunks_data = splitter.split_documents_with_chunks(documents)

        assert isinstance(nodes, list)
        assert hasattr(chunks_data, "items")
        assert hasattr(chunks_data, "total_count")
        assert hasattr(chunks_data, "splitter_type")

    def test_split_with_chunks_counts_match(self):
        """Test that node count matches chunks data count."""
        splitter = SmartSplitter(".pdf")
        content = "This is test content for counting. " * 200
        documents = [Document(text=content)]

        nodes, chunks_data = splitter.split_documents_with_chunks(documents)

        assert len(nodes) == chunks_data.total_count
        assert len(chunks_data.items) == chunks_data.total_count

    def test_split_with_chunks_has_token_counts(self):
        """Test that chunks data includes token counts."""
        splitter = SmartSplitter(".docx")
        content = "This is test content with tokens. " * 200
        documents = [Document(text=content)]

        nodes, chunks_data = splitter.split_documents_with_chunks(documents)

        for chunk_item in chunks_data.items:
            assert hasattr(chunk_item, "token_count")
            assert chunk_item.token_count >= 0


class TestSmartSplitterConstants:
    """Test configuration constants."""

    def test_supported_extensions_set(self):
        """Test that SMART_SUPPORTED_EXTENSIONS contains all expected types."""
        assert ".md" in SMART_SUPPORTED_EXTENSIONS
        assert ".txt" in SMART_SUPPORTED_EXTENSIONS
        assert ".pdf" in SMART_SUPPORTED_EXTENSIONS
        assert ".docx" in SMART_SUPPORTED_EXTENSIONS
        assert ".doc" in SMART_SUPPORTED_EXTENSIONS
        assert len(SMART_SUPPORTED_EXTENSIONS) == 5

    def test_chunk_size_constants(self):
        """Test that chunk size constants are positive."""
        assert TXT_CHUNK_SIZE > 0
        assert MD_CHUNK_SIZE > 0
        assert PDF_CHUNK_SIZE > 0
        assert DOCX_CHUNK_SIZE > 0

    def test_chunk_overlap_less_than_size(self):
        """Test that overlap is less than chunk size."""
        assert TXT_CHUNK_OVERLAP < TXT_CHUNK_SIZE
        assert MD_CHUNK_OVERLAP < MD_CHUNK_SIZE
        assert PDF_CHUNK_OVERLAP < PDF_CHUNK_SIZE
        assert DOCX_CHUNK_OVERLAP < DOCX_CHUNK_SIZE
