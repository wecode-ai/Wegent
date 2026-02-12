# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for document processing pipeline components.
"""

from unittest.mock import Mock, patch

import pytest
from llama_index.core import Document

from app.services.rag.pipeline.base import BaseDocumentPipeline
from app.services.rag.pipeline.factory import (
    OFFICE_EXTENSIONS,
    PDF_EXTENSIONS,
    create_pipeline,
    get_pipeline_info,
    should_use_pipeline,
)
from app.services.rag.pipeline.llamaindex import LlamaIndexPipeline
from app.services.rag.pipeline.pandoc import (
    PandocConversionError,
    PandocNotFoundError,
    PandocPipeline,
)


class TestBaseDocumentPipeline:
    """Tests for t abstract base class."""

    def test_base_class_cannot_be_instantiated(self):
        """Test that BaseDocumentPipeline cannot be instantiated directly."""
        with pytest.raises(TypeError):
            BaseDocumentPipeline()

    def test_default_chunk_size_and_overlap(self):
        """Test default chunk size and overlap values."""
        assert BaseDocumentPipeline.DEFAULT_CHUNK_SIZE == 1024
        assert BaseDocumentPipeline.DEFAULT_CHUNK_OVERLAP == 50


class TestLlamaIndexPipeline:
    """Tests for LlamaIndexPipeline."""

    def test_init_with_defaults(self):
        """Test initialization with default values."""
        pipeline = LlamaIndexPipeline(file_extension=".pdf")
        assert pipeline.file_extension == ".pdf"
        assert pipeline.chunk_size == 1024
        assert pipeline.chunk_overlap == 50

    def test_init_with_custom_values(self):
        """Test initialization with custom values."""
        pipeline = LlamaIndexPipeline(
            file_extension=".txt",
            chunk_size=512,
            chunk_overlap=100,
        )
        assert pipeline.file_extension == ".txt"
        assert pipeline.chunk_size == 512
        assert pipeline.chunk_overlap == 100

    def test_supported_extensions(self):
        """Test supported extensions class method."""
        extensions = LlamaIndexPipeline.get_supported_extensions()
        assert ".pdf" in extensions
        assert ".txt" in extensions
        assert ".md" in extensions

    def test_read_passes_through_binary_data(self):
        """Test that read() returns binary data unchanged."""
        pipeline = LlamaIndexPipeline(file_extension=".txt")
        data = b"Hello, World!"
        result = pipeline.read(data, ".txt")
        assert result == data

    def test_split_empty_content(self):
        """Test split() with empty content."""
        pipeline = LlamaIndexPipeline(file_extension=".txt")
        result = pipeline.split("")
        assert result == []

    def test_split_whitespace_only(self):
        """Test split() with whitespace-only content."""
        pipeline = LlamaIndexPipeline(file_extension=".txt")
        result = pipeline.split("   \n\n   ")
        assert result == []


class TestPandocPipeline:
    """Tests for PandocPipeline."""

    def test_is_pandoc_available_true(self):
        """Test Pandoc availability check when Pandoc is installed."""
        with patch("builtins.__import__") as mock_import:
            # Create a mock pypandoc module
            mock_pypandoc = Mock()
            mock_pypandoc.get_pandoc_version.return_value = "3.1.0"
            # Set up __import__ to return our mock
            mock_import.return_value = mock_pypandoc

            assert PandocPipeline.is_pandoc_available() is True

    def test_is_pandoc_available_false(self):
        """Test Pandoc availability check when Pandoc is not installed."""
        with patch("builtins.__import__") as mock_import:
            # Set up __import__ to raise ImportError
            mock_import.side_effect = ImportError("No module named 'pypandoc'")

            assert PandocPipeline.is_pandoc_available() is False

    def test_init_raises_when_pandoc_not_found(self):
        """Test that initialization raises error when Pandoc is not found."""
        with patch("builtins.__import__") as mock_import:
            # Create a mock pypandoc module that raises OSError
            mock_pypandoc = Mock()
            mock_pypandoc.get_pandoc_version.side_effect = OSError("Pandoc not found")
            mock_pypandoc.download_pandoc.side_effect = Exception("Download failed")
            mock_import.return_value = mock_pypandoc

            with pytest.raises(PandocNotFoundError):
                PandocPipeline()

    def test_supported_extensions(self):
        """Test supported extensions."""
        extensions = PandocPipeline.get_supported_extensions()
        assert ".doc" in extensions
        assert ".docx" in extensions
        assert ".ppt" in extensions
        assert ".pptx" in extensions

    def test_read_passes_through_binary_data(self):
        """Test that read() returns binary data unchanged."""
        with patch("builtins.__import__") as mock_import:
            # Create a mock pypandoc module
            mock_pypandoc = Mock()
            mock_pypandoc.get_pandoc_version.return_value = "3.1.0"
            mock_import.return_value = mock_pypandoc

            pipeline = PandocPipeline()
            data = b"Test document content"
            result = pipeline.read(data, ".docx")
            assert result == data

    def test_convert_unsupported_format(self):
        """Test convert() with unsupported file format."""
        with patch("builtins.__import__") as mock_import:
            # Create a mock pypandoc module
            mock_pypandoc = Mock()
            mock_pypandoc.get_pandoc_version.return_value = "3.1.0"
            mock_import.return_value = mock_pypandoc

            pipeline = PandocPipeline()
            with pytest.raises(PandocConversionError):
                pipeline.convert(b"data", ".xyz")

    def test_split_empty_content(self):
        """Test split() with empty content."""
        with patch("builtins.__import__") as mock_import:
            # Create a mock pypandoc module
            mock_pypandoc = Mock()
            mock_pypandoc.get_pandoc_version.return_value = "3.1.0"
            mock_import.return_value = mock_pypandoc

            pipeline = PandocPipeline()
            result = pipeline.split("")
            assert result == []


class TestPipelineFactory:
    """Tests for pipeline factory functions."""

    def test_should_use_pipeline_for_office_documents(self):
        """Test that Office documents should use pipeline."""
        assert should_use_pipeline(".doc") is True
        assert should_use_pipeline(".docx") is True
        assert should_use_pipeline(".ppt") is True
        assert should_use_pipeline(".pptx") is True

    def test_should_use_pipeline_for_pdf(self):
        """Test that PDF should not use pipeline."""
        assert should_use_pipeline(".pdf") is False

    def test_should_use_pipeline_for_other_files(self):
        """Test that other file types should not use pipeline."""
        assert should_use_pipeline(".txt") is False
        assert should_use_pipeline(".md") is False
        assert should_use_pipeline(".json") is False

    @patch(
        "app.services.rag.pipeline.pandoc.PandocPipeline.is_pandoc_available",
        return_value=True,
    )
    def test_create_pipeline_for_docx_with_pandoc(self, mock_pandoc):
        """Test creating pipeline for DOCX when Pandoc is available."""
        pipeline = create_pipeline(".docx")
        assert isinstance(pipeline, PandocPipeline)

    def test_create_pipeline_for_txt(self):
        """Test creating pipeline for TXT file."""
        pipeline = create_pipeline(".txt")
        assert isinstance(pipeline, LlamaIndexPipeline)

    def test_create_pipeline_for_md(self):
        """Test creating pipeline for Markdown file."""
        pipeline = create_pipeline(".md")
        assert isinstance(pipeline, LlamaIndexPipeline)

    def test_create_pipeline_for_pdf(self):
        """Test creating pipeline for PDF."""
        pipeline = create_pipeline(".pdf")
        assert isinstance(pipeline, LlamaIndexPipeline)

    @patch(
        "app.services.rag.pipeline.pandoc.PandocPipeline.is_pandoc_available",
        return_value=False,
    )
    def test_create_pipeline_raises_for_office_without_pandoc(self, mock_pandoc):
        """Test that creating pipeline for Office docs without Pandoc raises."""
        with pytest.raises(ValueError) as exc_info:
            create_pipeline(".docx")
        assert "Pandoc is not installed" in str(exc_info.value)

    @patch(
        "app.services.rag.pipeline.pandoc.PandocPipeline.is_pandoc_available",
        return_value=True,
    )
    def test_get_pipeline_info_for_docx(self, mock_pandoc):
        """Test getting pipeline info for DOCX file."""
        info = get_pipeline_info(".docx")
        assert info["file_extension"] == ".docx"
        assert info["requires_pipeline"] is True
        assert "PandocPipeline" in info["recommended_pipeline"]

    def test_get_pipeline_info_for_txt(self):
        """Test getting pipeline info for TXT file."""
        info = get_pipeline_info(".txt")
        assert info["file_extension"] == ".txt"
        assert info["requires_pipeline"] is False
        assert info["recommended_pipeline"] == "LlamaIndexPipeline"


class TestPipelineIntegration:
    """Integration tests for pipeline components."""

    def test_llamaindex_pipeline_split_text_document(self):
        """Test LlamaIndex pipeline splitting text content."""
        pipeline = LlamaIndexPipeline(
            file_extension=".txt",
            chunk_size=100,
            chunk_overlap=10,
        )

        # Create a text content
        content = "This is a test document. " * 50  # About 1300 characters

        # Split content
        documents = pipeline.split(content)

        # Should create multiple chunks
        assert len(documents) > 1
        for doc in documents:
            assert isinstance(doc, Document)
            # Chunks may exceed target size due to sentence boundaries
            # Just verify we have valid documents
            assert len(doc.text) > 0

    def test_pandoc_pipeline_split_markdown(self):
        """Test Pandoc pipeline splitting markdown content."""
        # Mock pypandoc module using builtins import
        import sys

        mock_pypandoc = Mock()
        mock_pypandoc.get_pandoc_version.return_value = "3.1.0"

        with patch.dict(sys.modules, {"pypandoc": mock_pypandoc}):
            # Reset the _pandoc_ensured flag to force re-check
            PandocPipeline._pandoc_ensured = False

            pipeline = PandocPipeline(
                chunk_size=100,
                chunk_overlap=10,
            )

            markdown_content = "# Header 1\n\nThis is first section with some content.\n\n## Header 2\n\nThis is second section with more content.\n"

            documents = pipeline.split(markdown_content)

            # Should create chunks
            assert len(documents) >= 1
            for doc in documents:
                assert isinstance(doc, Document)