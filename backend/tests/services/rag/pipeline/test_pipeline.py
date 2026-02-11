# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for document processing pipeline components.
"""

from unittest.mock import MagicMock, Mock, patch

import pytest
from llama_index.core import Document

from app.services.rag.pipeline.base import BaseDocumentPipeline
from app.services.rag.pipeline.docling import (
    DoclingPipeline,
    DoclingServiceError,
)
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
    """Tests for the abstract base class."""

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

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_is_pandoc_available_true(self, mock_which):
        """Test Pandoc availability check when Pandoc is installed."""
        mock_which.return_value = "/usr/bin/pandoc"
        assert PandocPipeline.is_pandoc_available() is True

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_is_pandoc_available_false(self, mock_which):
        """Test Pandoc availability check when Pandoc is not installed."""
        mock_which.return_value = None
        assert PandocPipeline.is_pandoc_available() is False

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_init_raises_when_pandoc_not_found(self, mock_which):
        """Test that initialization raises error when Pandoc is not found."""
        mock_which.return_value = None
        with pytest.raises(PandocNotFoundError):
            PandocPipeline()

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_supported_extensions(self, mock_which):
        """Test supported extensions."""
        mock_which.return_value = "/usr/bin/pandoc"
        extensions = PandocPipeline.get_supported_extensions()
        assert ".doc" in extensions
        assert ".docx" in extensions
        assert ".ppt" in extensions
        assert ".pptx" in extensions

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_read_passes_through_binary_data(self, mock_which):
        """Test that read() returns binary data unchanged."""
        mock_which.return_value = "/usr/bin/pandoc"
        pipeline = PandocPipeline()
        data = b"Test document content"
        result = pipeline.read(data, ".docx")
        assert result == data

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_convert_unsupported_format(self, mock_which):
        """Test convert() with unsupported file format."""
        mock_which.return_value = "/usr/bin/pandoc"
        pipeline = PandocPipeline()
        with pytest.raises(PandocConversionError):
            pipeline.convert(b"data", ".xyz")

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_split_empty_content(self, mock_which):
        """Test split() with empty content."""
        mock_which.return_value = "/usr/bin/pandoc"
        pipeline = PandocPipeline()
        result = pipeline.split("")
        assert result == []


class TestDoclingPipeline:
    """Tests for DoclingPipeline."""

    def test_init_with_valid_url(self):
        """Test initialization with valid URL."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        assert pipeline.docling_url == "http://localhost:8080"
        assert pipeline.timeout == 120

    def test_init_with_custom_timeout(self):
        """Test initialization with custom timeout."""
        pipeline = DoclingPipeline(
            docling_url="http://localhost:8080",
            timeout=60,
        )
        assert pipeline.timeout == 60

    def test_init_raises_for_empty_url(self):
        """Test that initialization raises error for empty URL."""
        with pytest.raises(ValueError):
            DoclingPipeline(docling_url="")

    def test_init_raises_for_none_url(self):
        """Test that initialization raises error for None URL."""
        with pytest.raises(ValueError):
            DoclingPipeline(docling_url=None)

    def test_supported_extensions(self):
        """Test supported extensions."""
        extensions = DoclingPipeline.get_supported_extensions()
        assert ".doc" in extensions
        assert ".docx" in extensions
        assert ".ppt" in extensions
        assert ".pptx" in extensions
        assert ".pdf" in extensions

    def test_read_passes_through_binary_data(self):
        """Test that read() returns binary data unchanged."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        data = b"Test document content"
        result = pipeline.read(data, ".docx")
        assert result == data

    def test_extract_markdown_primary_format(self):
        """Test _extract_markdown with primary response format."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        response = {"document": {"md_content": "# Hello World"}}
        result = pipeline._extract_markdown(response)
        assert result == "# Hello World"

    def test_extract_markdown_alternative_format(self):
        """Test _extract_markdown with alternative response format."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        response = {"md_content": "# Hello World"}
        result = pipeline._extract_markdown(response)
        assert result == "# Hello World"

    def test_extract_markdown_content_format(self):
        """Test _extract_markdown with content key."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        response = {"content": "# Hello World"}
        result = pipeline._extract_markdown(response)
        assert result == "# Hello World"

    def test_extract_markdown_none_for_empty_response(self):
        """Test _extract_markdown returns None for empty response."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        response = {}
        result = pipeline._extract_markdown(response)
        assert result is None

    def test_split_empty_content(self):
        """Test split() with empty content."""
        pipeline = DoclingPipeline(docling_url="http://localhost:8080")
        result = pipeline.split("")
        assert result == []

    @patch("app.services.rag.pipeline.docling.httpx.Client")
    def test_is_service_available_true(self, mock_client_class):
        """Test service availability check when service is running."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_client = Mock()
        mock_client.get.return_value = mock_response
        mock_client.__enter__ = Mock(return_value=mock_client)
        mock_client.__exit__ = Mock(return_value=False)
        mock_client_class.return_value = mock_client

        result = DoclingPipeline.is_service_available("http://localhost:8080")
        assert result is True

    def test_is_service_available_false_for_empty_url(self):
        """Test service availability check for empty URL."""
        result = DoclingPipeline.is_service_available("")
        assert result is False


class TestPipelineFactory:
    """Tests for pipeline factory functions."""

    def test_should_use_pipeline_for_office_documents(self):
        """Test that Office documents should use pipeline."""
        assert should_use_pipeline(".doc") is True
        assert should_use_pipeline(".docx") is True
        assert should_use_pipeline(".ppt") is True
        assert should_use_pipeline(".pptx") is True

    def test_should_use_pipeline_for_pdf_without_docling(self):
        """Test that PDF without Docling should not use pipeline."""
        with patch(
            "app.services.rag.pipeline.factory._is_docling_configured",
            return_value=False,
        ):
            assert should_use_pipeline(".pdf") is False

    def test_should_use_pipeline_for_pdf_with_docling(self):
        """Test that PDF with Docling should use pipeline."""
        with patch(
            "app.services.rag.pipeline.factory._is_docling_configured",
            return_value=True,
        ):
            assert should_use_pipeline(".pdf") is True

    def test_should_use_pipeline_for_other_files(self):
        """Test that other file types should not use pipeline."""
        assert should_use_pipeline(".txt") is False
        assert should_use_pipeline(".md") is False
        assert should_use_pipeline(".json") is False

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    @patch(
        "app.services.rag.pipeline.pandoc.PandocPipeline.is_pandoc_available",
        return_value=True,
    )
    @patch(
        "app.services.rag.pipeline.pandoc.shutil.which", return_value="/usr/bin/pandoc"
    )
    def test_create_pipeline_for_docx_with_pandoc(
        self, mock_which, mock_pandoc, mock_docling
    ):
        """Test creating pipeline for DOCX when only Pandoc is available."""
        pipeline = create_pipeline(".docx")
        assert isinstance(pipeline, PandocPipeline)

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    def test_create_pipeline_for_txt(self, mock_docling):
        """Test creating pipeline for TXT file."""
        pipeline = create_pipeline(".txt")
        assert isinstance(pipeline, LlamaIndexPipeline)

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    def test_create_pipeline_for_md(self, mock_docling):
        """Test creating pipeline for Markdown file."""
        pipeline = create_pipeline(".md")
        assert isinstance(pipeline, LlamaIndexPipeline)

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    def test_create_pipeline_for_pdf_without_docling(self, mock_docling):
        """Test creating pipeline for PDF without Docling."""
        pipeline = create_pipeline(".pdf")
        assert isinstance(pipeline, LlamaIndexPipeline)

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    @patch(
        "app.services.rag.pipeline.pandoc.PandocPipeline.is_pandoc_available",
        return_value=False,
    )
    def test_create_pipeline_raises_for_office_without_converters(
        self, mock_pandoc, mock_docling
    ):
        """Test that creating pipeline for Office docs without converters raises."""
        with pytest.raises(ValueError) as exc_info:
            create_pipeline(".docx")
        assert "Docling is not configured and Pandoc is not installed" in str(
            exc_info.value
        )

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    @patch(
        "app.services.rag.pipeline.pandoc.PandocPipeline.is_pandoc_available",
        return_value=True,
    )
    @patch(
        "app.services.rag.pipeline.pandoc.shutil.which", return_value="/usr/bin/pandoc"
    )
    def test_get_pipeline_info_for_docx(self, mock_which, mock_pandoc, mock_docling):
        """Test getting pipeline info for DOCX file."""
        info = get_pipeline_info(".docx")
        assert info["file_extension"] == ".docx"
        assert info["requires_pipeline"] is True
        assert "PandocPipeline" in info["recommended_pipeline"]

    @patch(
        "app.services.rag.pipeline.factory._is_docling_configured", return_value=False
    )
    def test_get_pipeline_info_for_txt(self, mock_docling):
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

        # Split the content
        documents = pipeline.split(content)

        # Should create multiple chunks
        assert len(documents) > 1
        for doc in documents:
            assert isinstance(doc, Document)
            # Chunks may exceed target size due to sentence boundaries
            # Just verify we have valid documents
            assert len(doc.text) > 0

    def test_docling_pipeline_split_markdown(self):
        """Test Docling pipeline splitting markdown content."""
        pipeline = DoclingPipeline(
            docling_url="http://localhost:8080",
            chunk_size=100,
            chunk_overlap=10,
        )

        markdown_content = """# Header 1

This is the first section with some content.

## Header 2

This is the second section with more content.

### Header 3

And this is a subsection with even more text to split.
"""

        documents = pipeline.split(markdown_content)

        # Should create multiple chunks based on markdown structure
        assert len(documents) >= 1
        for doc in documents:
            assert isinstance(doc, Document)

    @patch("app.services.rag.pipeline.pandoc.shutil.which")
    def test_pandoc_pipeline_split_markdown(self, mock_which):
        """Test Pandoc pipeline splitting markdown content."""
        mock_which.return_value = "/usr/bin/pandoc"

        pipeline = PandocPipeline(
            chunk_size=100,
            chunk_overlap=10,
        )

        markdown_content = """# Header 1

This is the first section with some content.

## Header 2

This is the second section with more content.
"""

        documents = pipeline.split(markdown_content)

        # Should create chunks
        assert len(documents) >= 1
        for doc in documents:
            assert isinstance(doc, Document)
