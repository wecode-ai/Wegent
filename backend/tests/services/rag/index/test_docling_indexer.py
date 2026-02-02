# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for DocumentIndexer Docling processing functionality.

Tests cover:
1. should_use_docling and is_excel_file helper functions
2. _process_with_docling method for various file types
3. index_from_binary method with Docling vs SimpleDirectoryReader
4. _build_chunks_metadata with docling config
5. Error handling for DoclingReader failures

Note: Tests requiring llama-index-readers-docling are marked with
@pytest.mark.skipif when the dependency is not installed.
"""

import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import pytest
from llama_index.core import Document
from llama_index.core.schema import TextNode

from app.schemas.rag import DoclingPipelineConfig, SmartSplitterConfig
from app.services.rag.index.indexer import (
    DOCLING_AVAILABLE,
    DOCLING_EXTENSIONS,
    EXCEL_EXTENSIONS,
    DocumentIndexer,
    is_excel_file,
    sanitize_metadata,
    should_use_docling,
)

# Check if llama-index-readers-docling is available
try:
    from llama_index.readers.docling import DoclingReader
    DOCLING_AVAILABLE = True
except ImportError:
    DOCLING_AVAILABLE = False

# Skip marker for tests requiring DoclingReader
requires_docling = pytest.mark.skipif(
    not DOCLING_AVAILABLE,
    reason="llama-index-readers-docling not installed"
)


class TestHelperFunctions:
    """Tests for helper functions."""

    @requires_docling
    def test_should_use_docling_md(self):
        """Test should_use_docling returns True for .md files when docling is available."""
        assert should_use_docling(".md") is True
        assert should_use_docling(".MD") is True

    @requires_docling
    def test_should_use_docling_pdf(self):
        """Test should_use_docling returns True for .pdf files when docling is available."""
        assert should_use_docling(".pdf") is True
        assert should_use_docling(".PDF") is True

    @requires_docling
    def test_should_use_docling_doc_docx(self):
        """Test should_use_docling returns True for .doc/.docx files when docling is available."""
        assert should_use_docling(".doc") is True
        assert should_use_docling(".docx") is True
        assert should_use_docling(".DOC") is True
        assert should_use_docling(".DOCX") is True

    @requires_docling
    def test_should_use_docling_ppt_pptx(self):
        """Test should_use_docling returns True for .ppt/.pptx files when docling is available."""
        assert should_use_docling(".ppt") is True
        assert should_use_docling(".pptx") is True
        assert should_use_docling(".PPT") is True
        assert should_use_docling(".PPTX") is True

    @requires_docling
    def test_should_use_docling_xls_xlsx(self):
        """Test should_use_docling returns True for .xls/.xlsx files when docling is available."""
        assert should_use_docling(".xls") is True
        assert should_use_docling(".xlsx") is True
        assert should_use_docling(".XLS") is True
        assert should_use_docling(".XLSX") is True

    def test_should_use_docling_txt_returns_false(self):
        """Test should_use_docling returns False for .txt files."""
        assert should_use_docling(".txt") is False
        assert should_use_docling(".TXT") is False

    def test_should_use_docling_unknown_returns_false(self):
        """Test should_use_docling returns False for unknown extensions."""
        assert should_use_docling(".csv") is False
        assert should_use_docling(".json") is False
        assert should_use_docling(".xml") is False
        assert should_use_docling(".html") is False

    def test_should_use_docling_returns_false_when_not_available(self):
        """Test should_use_docling returns False when docling is not installed."""
        # This test verifies the fallback behavior
        from app.services.rag.index import indexer
        original_value = indexer.DOCLING_AVAILABLE
        try:
            indexer.DOCLING_AVAILABLE = False
            assert should_use_docling(".pdf") is False
            assert should_use_docling(".docx") is False
            assert should_use_docling(".xlsx") is False
        finally:
            indexer.DOCLING_AVAILABLE = original_value

    def test_is_excel_file_true(self):
        """Test is_excel_file returns True for Excel files."""
        assert is_excel_file(".xls") is True
        assert is_excel_file(".xlsx") is True
        assert is_excel_file(".XLS") is True
        assert is_excel_file(".XLSX") is True

    def test_is_excel_file_false(self):
        """Test is_excel_file returns False for non-Excel files."""
        assert is_excel_file(".pdf") is False
        assert is_excel_file(".docx") is False
        assert is_excel_file(".md") is False
        assert is_excel_file(".txt") is False

    def test_docling_extensions_constant(self):
        """Test DOCLING_EXTENSIONS contains expected file types."""
        expected = {".md", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}
        assert DOCLING_EXTENSIONS == expected

    def test_excel_extensions_constant(self):
        """Test EXCEL_EXTENSIONS contains expected file types."""
        expected = {".xls", ".xlsx"}
        assert EXCEL_EXTENSIONS == expected


class TestDoclingPipelineConfig:
    """Tests for DoclingPipelineConfig schema."""

    def test_docling_config_markdown_defaults(self):
        """Test DoclingPipelineConfig with markdown defaults."""
        config = DoclingPipelineConfig(
            export_type="markdown",
            file_extension=".pdf",
        )
        assert config.type == "docling"
        assert config.export_type == "markdown"
        assert config.ocr is False
        assert config.export_images is False
        assert config.heading_level_limit == 3
        assert config.chunk_size == 1024
        assert config.chunk_overlap == 50
        assert config.separator is None
        assert config.file_extension == ".pdf"

    def test_docling_config_excel_json(self):
        """Test DoclingPipelineConfig with Excel JSON format."""
        config = DoclingPipelineConfig(
            export_type="json",
            file_extension=".xlsx",
            separator=";\n",
        )
        assert config.type == "docling"
        assert config.export_type == "json"
        assert config.separator == ";\n"
        assert config.file_extension == ".xlsx"

    def test_docling_config_chunk_overlap_validation(self):
        """Test DoclingPipelineConfig validates chunk_overlap < chunk_size."""
        with pytest.raises(ValueError, match="must be less than chunk_size"):
            DoclingPipelineConfig(
                export_type="markdown",
                file_extension=".pdf",
                chunk_size=512,
                chunk_overlap=600,  # Invalid: overlap > chunk_size
            )

    def test_docling_config_model_dump(self):
        """Test DoclingPipelineConfig serializes correctly."""
        config = DoclingPipelineConfig(
            export_type="markdown",
            file_extension=".docx",
        )
        data = config.model_dump()
        assert data["type"] == "docling"
        assert data["export_type"] == "markdown"
        assert data["file_extension"] == ".docx"


class TestDocumentIndexerProcessWithDocling:
    """Tests for DocumentIndexer._process_with_docling method."""

    @pytest.fixture
    def mock_storage_backend(self):
        """Create a mock storage backend."""
        backend = MagicMock()
        backend.index_with_metadata.return_value = {
            "indexed_count": 5,
            "index_name": "test_index",
            "status": "success",
        }
        return backend

    @pytest.fixture
    def mock_embed_model(self):
        """Create a mock embedding model."""
        return MagicMock()

    @pytest.fixture
    def indexer(self, mock_storage_backend, mock_embed_model):
        """Create a DocumentIndexer instance with mocks.

        Uses SmartSplitterConfig to avoid SemanticSplitter embed_model validation.
        """
        # Use SmartSplitterConfig to avoid embed_model validation
        splitter_config = SmartSplitterConfig(
            type="smart",
            chunk_size=1024,
            chunk_overlap=50,
            file_extension=".txt",
        )
        return DocumentIndexer(
            storage_backend=mock_storage_backend,
            embed_model=mock_embed_model,
            splitter_config=splitter_config,
        )

    @requires_docling
    @patch("llama_index.readers.docling.DoclingReader")
    @patch("app.services.rag.index.indexer.IngestionPipeline")
    def test_process_with_docling_markdown_file(
        self, mock_pipeline_cls, mock_reader_cls, indexer
    ):
        """Test _process_with_docling for markdown files."""
        # Setup mocks
        mock_document = Document(text="# Test\n\nContent here", metadata={})
        mock_reader = MagicMock()
        mock_reader.load_data.return_value = [mock_document]
        mock_reader_cls.return_value = mock_reader

        mock_nodes = [
            TextNode(text="# Test"),
            TextNode(text="Content here"),
        ]
        mock_pipeline = MagicMock()
        mock_pipeline.run.return_value = mock_nodes
        mock_pipeline_cls.return_value = mock_pipeline

        # Execute
        binary_data = b"# Test\n\nContent here"
        documents, nodes, config = indexer._process_with_docling(
            binary_data=binary_data,
            file_extension=".md",
            source_file="test.md",
        )

        # Verify DoclingReader was configured correctly
        mock_reader_cls.assert_called_once()
        call_kwargs = mock_reader_cls.call_args[1]
        assert call_kwargs["ocr"] is False
        assert call_kwargs["export_images"] is False

        # Verify results
        assert len(documents) == 1
        assert len(nodes) == 2
        assert config.type == "docling"
        assert config.export_type == "markdown"
        assert config.file_extension == ".md"

    @requires_docling
    @patch("llama_index.readers.docling.DoclingReader")
    @patch("app.services.rag.index.indexer.IngestionPipeline")
    def test_process_with_docling_pdf_file(
        self, mock_pipeline_cls, mock_reader_cls, indexer
    ):
        """Test _process_with_docling for PDF files."""
        # Setup mocks
        mock_document = Document(text="PDF content", metadata={})
        mock_reader = MagicMock()
        mock_reader.load_data.return_value = [mock_document]
        mock_reader_cls.return_value = mock_reader

        mock_nodes = [TextNode(text="PDF content")]
        mock_pipeline = MagicMock()
        mock_pipeline.run.return_value = mock_nodes
        mock_pipeline_cls.return_value = mock_pipeline

        # Execute
        binary_data = b"%PDF-1.4 fake pdf content"
        documents, nodes, config = indexer._process_with_docling(
            binary_data=binary_data,
            file_extension=".pdf",
            source_file="document.pdf",
        )

        # Verify config
        assert config.export_type == "markdown"
        assert config.file_extension == ".pdf"
        assert config.ocr is False

    @requires_docling
    @patch("llama_index.readers.docling.DoclingReader")
    @patch("app.services.rag.index.indexer.IngestionPipeline")
    def test_process_with_docling_excel_file(
        self, mock_pipeline_cls, mock_reader_cls, indexer
    ):
        """Test _process_with_docling for Excel files uses JSON export."""
        # Setup mocks
        mock_document = Document(text='{"row": 1, "data": "value"}', metadata={})
        mock_reader = MagicMock()
        mock_reader.load_data.return_value = [mock_document]
        mock_reader_cls.return_value = mock_reader

        mock_nodes = [TextNode(text='{"row": 1, "data": "value"}')]
        mock_pipeline = MagicMock()
        mock_pipeline.run.return_value = mock_nodes
        mock_pipeline_cls.return_value = mock_pipeline

        # Execute
        binary_data = b"fake excel content"
        documents, nodes, config = indexer._process_with_docling(
            binary_data=binary_data,
            file_extension=".xlsx",
            source_file="data.xlsx",
        )

        # Verify Excel-specific config
        assert config.export_type == "json"
        assert config.file_extension == ".xlsx"
        assert config.separator == ";\n"

    @requires_docling
    @patch("llama_index.readers.docling.DoclingReader")
    def test_process_with_docling_raises_on_failure(
        self, mock_reader_cls, indexer
    ):
        """Test _process_with_docling raises exception on DoclingReader failure."""
        # Setup mock to raise exception
        mock_reader = MagicMock()
        mock_reader.load_data.side_effect = Exception("Parse error")
        mock_reader_cls.return_value = mock_reader

        # Execute and verify exception
        with pytest.raises(RuntimeError) as exc_info:
            indexer._process_with_docling(
                binary_data=b"invalid content",
                file_extension=".pdf",
                source_file="broken.pdf",
            )

        assert "DoclingReader failed to process file" in str(exc_info.value)
        assert "filename=broken.pdf" in str(exc_info.value)
        assert "extension=.pdf" in str(exc_info.value)

    @requires_docling
    @patch("llama_index.readers.docling.DoclingReader")
    def test_process_with_docling_raises_on_empty_result(
        self, mock_reader_cls, indexer
    ):
        """Test _process_with_docling raises when DoclingReader returns no documents."""
        # Setup mock to return empty list
        mock_reader = MagicMock()
        mock_reader.load_data.return_value = []
        mock_reader_cls.return_value = mock_reader

        # Execute and verify exception
        with pytest.raises(RuntimeError) as exc_info:
            indexer._process_with_docling(
                binary_data=b"content",
                file_extension=".docx",
                source_file="empty.docx",
            )

        assert "returned no documents" in str(exc_info.value)

    @requires_docling
    @patch("llama_index.readers.docling.DoclingReader")
    @patch("app.services.rag.index.indexer.IngestionPipeline")
    def test_process_with_docling_updates_metadata(
        self, mock_pipeline_cls, mock_reader_cls, indexer
    ):
        """Test _process_with_docling updates document metadata correctly."""
        # Setup mocks
        mock_document = Document(text="Content", metadata={"original_key": "value"})
        mock_reader = MagicMock()
        mock_reader.load_data.return_value = [mock_document]
        mock_reader_cls.return_value = mock_reader

        mock_pipeline = MagicMock()
        mock_pipeline.run.return_value = [TextNode(text="Content")]
        mock_pipeline_cls.return_value = mock_pipeline

        # Execute
        documents, nodes, config = indexer._process_with_docling(
            binary_data=b"content",
            file_extension=".md",
            source_file="test_file.md",
        )

        # Verify metadata was updated with filename (without extension)
        assert documents[0].metadata.get("filename") == "test_file"


class TestDocumentIndexerIndexFromBinary:
    """Tests for DocumentIndexer.index_from_binary method."""

    @pytest.fixture
    def mock_storage_backend(self):
        """Create a mock storage backend."""
        backend = MagicMock()
        backend.index_with_metadata.return_value = {
            "indexed_count": 5,
            "index_name": "test_index",
            "status": "success",
        }
        return backend

    @pytest.fixture
    def mock_embed_model(self):
        """Create a mock embedding model."""
        return MagicMock()

    @pytest.fixture
    def indexer(self, mock_storage_backend, mock_embed_model):
        """Create a DocumentIndexer instance with mocks.

        Uses SmartSplitterConfig to avoid SemanticSplitter embed_model validation.
        """
        splitter_config = SmartSplitterConfig(
            type="smart",
            chunk_size=1024,
            chunk_overlap=50,
            file_extension=".txt",
        )
        return DocumentIndexer(
            storage_backend=mock_storage_backend,
            embed_model=mock_embed_model,
            splitter_config=splitter_config,
        )

    @requires_docling
    @patch.object(DocumentIndexer, "_process_with_docling")
    @patch.object(DocumentIndexer, "_index_documents")
    def test_index_from_binary_uses_docling_for_pdf(
        self, mock_index_docs, mock_process_docling, indexer
    ):
        """Test index_from_binary uses Docling processing for PDF files."""
        # Setup mock returns
        mock_documents = [Document(text="PDF content")]
        mock_nodes = [TextNode(text="PDF content")]
        mock_config = DoclingPipelineConfig(
            export_type="markdown",
            file_extension=".pdf",
        )
        mock_process_docling.return_value = (mock_documents, mock_nodes, mock_config)
        mock_index_docs.return_value = {"status": "success"}

        # Execute
        result = indexer.index_from_binary(
            knowledge_id="kb-123",
            binary_data=b"pdf content",
            source_file="test.pdf",
            file_extension=".pdf",
            doc_ref="doc-456",
        )

        # Verify Docling processing was used
        mock_process_docling.assert_called_once()
        mock_index_docs.assert_called_once()

        # Verify pre_split_nodes and docling_config were passed
        call_kwargs = mock_index_docs.call_args[1]
        assert call_kwargs["pre_split_nodes"] == mock_nodes
        assert call_kwargs["docling_config"] == mock_config

    @patch.object(DocumentIndexer, "_process_with_simple_reader")
    def test_index_from_binary_uses_simple_reader_for_txt(
        self, mock_process_simple, indexer
    ):
        """Test index_from_binary uses SimpleReader for .txt files."""
        mock_process_simple.return_value = {"status": "success"}

        # Execute
        result = indexer.index_from_binary(
            knowledge_id="kb-123",
            binary_data=b"text content",
            source_file="test.txt",
            file_extension=".txt",
            doc_ref="doc-456",
        )

        # Verify SimpleReader was used
        mock_process_simple.assert_called_once()

    @requires_docling
    @patch.object(DocumentIndexer, "_process_with_docling")
    @patch.object(DocumentIndexer, "_index_documents")
    def test_index_from_binary_uses_docling_for_docx(
        self, mock_index_docs, mock_process_docling, indexer
    ):
        """Test index_from_binary uses Docling processing for DOCX files."""
        mock_documents = [Document(text="DOCX content")]
        mock_nodes = [TextNode(text="DOCX content")]
        mock_config = DoclingPipelineConfig(
            export_type="markdown",
            file_extension=".docx",
        )
        mock_process_docling.return_value = (mock_documents, mock_nodes, mock_config)
        mock_index_docs.return_value = {"status": "success"}

        # Execute
        result = indexer.index_from_binary(
            knowledge_id="kb-123",
            binary_data=b"docx content",
            source_file="test.docx",
            file_extension=".docx",
            doc_ref="doc-456",
        )

        # Verify Docling was used
        mock_process_docling.assert_called_once()

    @requires_docling
    @patch.object(DocumentIndexer, "_process_with_docling")
    @patch.object(DocumentIndexer, "_index_documents")
    def test_index_from_binary_uses_docling_for_xlsx(
        self, mock_index_docs, mock_process_docling, indexer
    ):
        """Test index_from_binary uses Docling processing for Excel files."""
        mock_documents = [Document(text="Excel content")]
        mock_nodes = [TextNode(text="Excel content")]
        mock_config = DoclingPipelineConfig(
            export_type="json",
            file_extension=".xlsx",
            separator=";\n",
        )
        mock_process_docling.return_value = (mock_documents, mock_nodes, mock_config)
        mock_index_docs.return_value = {"status": "success"}

        # Execute
        result = indexer.index_from_binary(
            knowledge_id="kb-123",
            binary_data=b"excel content",
            source_file="data.xlsx",
            file_extension=".xlsx",
            doc_ref="doc-456",
        )

        # Verify Docling was used
        mock_process_docling.assert_called_once()


class TestDocumentIndexerBuildChunksMetadata:
    """Tests for DocumentIndexer._build_chunks_metadata method."""

    @pytest.fixture
    def mock_storage_backend(self):
        """Create a mock storage backend."""
        return MagicMock()

    @pytest.fixture
    def mock_embed_model(self):
        """Create a mock embedding model."""
        return MagicMock()

    @pytest.fixture
    def indexer(self, mock_storage_backend, mock_embed_model):
        """Create a DocumentIndexer instance with mocks.

        Uses SmartSplitterConfig to avoid SemanticSplitter embed_model validation.
        """
        splitter_config = SmartSplitterConfig(
            type="smart",
            chunk_size=1024,
            chunk_overlap=50,
            file_extension=".txt",
        )
        return DocumentIndexer(
            storage_backend=mock_storage_backend,
            embed_model=mock_embed_model,
            splitter_config=splitter_config,
        )

    def test_build_chunks_metadata_with_docling_markdown(self, indexer):
        """Test _build_chunks_metadata with docling markdown config."""
        nodes = [
            TextNode(text="First chunk content"),
            TextNode(text="Second chunk content"),
        ]
        config = DoclingPipelineConfig(
            export_type="markdown",
            file_extension=".pdf",
        )

        result = indexer._build_chunks_metadata(nodes, docling_config=config)

        assert result["splitter_type"] == "docling"
        assert result["splitter_subtype"] == "markdown_pipeline"
        assert result["total_count"] == 2
        assert len(result["items"]) == 2
        assert result["items"][0]["content"] == "First chunk content"

    def test_build_chunks_metadata_with_docling_excel(self, indexer):
        """Test _build_chunks_metadata with docling excel config."""
        nodes = [
            TextNode(text='{"row": 1, "data": "value1"}'),
            TextNode(text='{"row": 2, "data": "value2"}'),
        ]
        config = DoclingPipelineConfig(
            export_type="json",
            file_extension=".xlsx",
            separator=";\n",
        )

        result = indexer._build_chunks_metadata(nodes, docling_config=config)

        assert result["splitter_type"] == "docling"
        assert result["splitter_subtype"] == "excel_json"
        assert result["total_count"] == 2

    def test_build_chunks_metadata_without_docling(self, indexer):
        """Test _build_chunks_metadata without docling config (default splitter)."""
        nodes = [
            TextNode(text="Chunk 1"),
            TextNode(text="Chunk 2"),
        ]

        result = indexer._build_chunks_metadata(nodes, docling_config=None)

        # Should use SmartSplitter type (from fixture config)
        assert result["splitter_type"] == "smart"
        # SmartSplitter subtype for .txt is "sentence"
        assert result["splitter_subtype"] == "sentence"

    def test_build_chunks_metadata_calculates_positions(self, indexer):
        """Test _build_chunks_metadata calculates positions correctly."""
        nodes = [
            TextNode(text="ABC"),  # 3 chars
            TextNode(text="DEFGH"),  # 5 chars
        ]

        result = indexer._build_chunks_metadata(nodes, docling_config=None)

        items = result["items"]
        assert items[0]["start_position"] == 0
        assert items[0]["end_position"] == 3
        assert items[1]["start_position"] == 3
        assert items[1]["end_position"] == 8

    def test_build_chunks_metadata_estimates_tokens(self, indexer):
        """Test _build_chunks_metadata estimates token count correctly."""
        # Token count is estimated as len(text) // 4
        nodes = [
            TextNode(text="12345678"),  # 8 chars -> 2 tokens
        ]

        result = indexer._build_chunks_metadata(nodes, docling_config=None)

        assert result["items"][0]["token_count"] == 2


class TestDocumentIndexerIndexDocuments:
    """Tests for DocumentIndexer._index_documents with pre_split_nodes."""

    @pytest.fixture
    def mock_storage_backend(self):
        """Create a mock storage backend."""
        backend = MagicMock()
        backend.index_with_metadata.return_value = {
            "indexed_count": 5,
            "index_name": "test_index",
            "status": "success",
        }
        return backend

    @pytest.fixture
    def mock_embed_model(self):
        """Create a mock embedding model."""
        return MagicMock()

    @pytest.fixture
    def indexer(self, mock_storage_backend, mock_embed_model):
        """Create a DocumentIndexer instance with mocks.

        Uses SmartSplitterConfig to avoid SemanticSplitter embed_model validation.
        """
        splitter_config = SmartSplitterConfig(
            type="smart",
            chunk_size=1024,
            chunk_overlap=50,
            file_extension=".txt",
        )
        return DocumentIndexer(
            storage_backend=mock_storage_backend,
            embed_model=mock_embed_model,
            splitter_config=splitter_config,
        )

    def test_index_documents_with_pre_split_nodes(self, indexer, mock_storage_backend):
        """Test _index_documents uses pre_split_nodes when provided."""
        documents = [Document(text="Original content")]
        pre_split_nodes = [
            TextNode(text="Pre-split node 1"),
            TextNode(text="Pre-split node 2"),
        ]
        docling_config = DoclingPipelineConfig(
            export_type="markdown",
            file_extension=".pdf",
        )

        result = indexer._index_documents(
            documents=documents,
            knowledge_id="kb-123",
            doc_ref="doc-456",
            source_file="test.pdf",
            pre_split_nodes=pre_split_nodes,
            docling_config=docling_config,
        )

        # Verify storage backend was called with pre-split nodes
        mock_storage_backend.index_with_metadata.assert_called_once()
        call_kwargs = mock_storage_backend.index_with_metadata.call_args[1]
        assert len(call_kwargs["nodes"]) == 2

        # Verify result contains docling config
        assert "splitter_config" in result
        assert result["splitter_config"]["type"] == "docling"

    def test_index_documents_without_pre_split_nodes_uses_splitter(
        self, indexer, mock_storage_backend
    ):
        """Test _index_documents uses internal splitter when no pre_split_nodes."""
        documents = [Document(text="Content to split")]

        # Mock the splitter
        indexer.splitter = MagicMock()
        indexer.splitter.split_documents.return_value = [
            TextNode(text="Split node 1"),
        ]

        result = indexer._index_documents(
            documents=documents,
            knowledge_id="kb-123",
            doc_ref="doc-456",
            source_file="test.txt",
        )

        # Verify internal splitter was used
        indexer.splitter.split_documents.assert_called_once_with(documents)

        # Verify no splitter_config in result (not using Docling)
        assert "splitter_config" not in result
