# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the document parser service.
"""

import pytest
from unittest.mock import patch, MagicMock
import io

from app.services.attachment.parser import (
    DocumentParser,
    DocumentParseError,
    ParseResult,
    TruncationInfo,
)


class TestDocumentParser:
    """Test cases for DocumentParser class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.parser = DocumentParser()

    def test_supported_extensions(self):
        """Test that all expected extensions are supported."""
        expected_extensions = [
            ".pdf",
            ".doc",
            ".docx",
            ".ppt",
            ".pptx",
            ".xls",
            ".xlsx",
            ".csv",
            ".txt",
            ".md",
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".bmp",
            ".webp",
        ]
        for ext in expected_extensions:
            assert self.parser.is_supported_extension(ext), f"Extension {ext} should be supported"

    def test_unsupported_extension(self):
        """Test that unsupported extensions are rejected."""
        unsupported = [".exe", ".dll", ".zip", ".rar", ".mp3", ".mp4"]
        for ext in unsupported:
            assert not self.parser.is_supported_extension(
                ext
            ), f"Extension {ext} should not be supported"

    def test_get_max_file_size(self):
        """Test that max file size is returned correctly."""
        max_size = DocumentParser.get_max_file_size()
        assert max_size > 0
        assert isinstance(max_size, int)

    def test_get_max_text_length(self):
        """Test that max text length is returned correctly."""
        max_length = DocumentParser.get_max_text_length()
        assert max_length > 0
        assert isinstance(max_length, int)

    def test_validate_file_size_within_limit(self):
        """Test file size validation within limit."""
        max_size = DocumentParser.get_max_file_size()
        assert DocumentParser.validate_file_size(max_size - 1) is True
        assert DocumentParser.validate_file_size(max_size) is True

    def test_validate_file_size_exceeds_limit(self):
        """Test file size validation exceeding limit."""
        max_size = DocumentParser.get_max_file_size()
        assert DocumentParser.validate_file_size(max_size + 1) is False

    def test_validate_text_length_within_limit(self):
        """Test text length validation within limit."""
        max_length = DocumentParser.get_max_text_length()
        text = "a" * (max_length - 1)
        assert DocumentParser.validate_text_length(text) is True

    def test_validate_text_length_exceeds_limit(self):
        """Test text length validation exceeding limit."""
        max_length = DocumentParser.get_max_text_length()
        text = "a" * (max_length + 1)
        assert DocumentParser.validate_text_length(text) is False

    def test_parse_unsupported_extension_raises_error(self):
        """Test that parsing unsupported extension raises DocumentParseError."""
        with pytest.raises(DocumentParseError) as exc_info:
            self.parser.parse(b"some content", ".exe")
        assert exc_info.value.error_code == DocumentParseError.UNSUPPORTED_TYPE

    def test_parse_text_file(self):
        """Test parsing plain text file."""
        content = "Hello, World!\nThis is a test file."
        binary_data = content.encode("utf-8")

        result = self.parser.parse(binary_data, ".txt")

        assert isinstance(result, ParseResult)
        assert result.text == content
        assert result.text_length == len(content)
        assert result.truncation_info is None

    def test_parse_text_file_with_truncation(self):
        """Test that text files are auto-truncated when exceeding max length."""
        max_length = DocumentParser.get_max_text_length()
        # Create content that exceeds max length
        content = "a" * (max_length + 1000)
        binary_data = content.encode("utf-8")

        result = self.parser.parse(binary_data, ".txt")

        assert isinstance(result, ParseResult)
        assert len(result.text) == max_length
        assert result.text_length == max_length
        assert result.truncation_info is not None
        assert result.truncation_info.is_truncated is True
        assert result.truncation_info.original_length == len(content)
        assert result.truncation_info.truncated_length == max_length

    def test_parse_csv_file(self):
        """Test parsing CSV file."""
        csv_content = "name,age,city\nAlice,30,NYC\nBob,25,LA"
        binary_data = csv_content.encode("utf-8")

        result = self.parser.parse(binary_data, ".csv")

        assert isinstance(result, ParseResult)
        assert "Alice" in result.text
        assert "Bob" in result.text
        assert result.truncation_info is None

    def test_document_parse_error_codes(self):
        """Test that DocumentParseError has proper error codes."""
        # Test unsupported type
        error = DocumentParseError("Test", DocumentParseError.UNSUPPORTED_TYPE)
        assert error.error_code == "unsupported_type"

        # Test encrypted PDF
        error = DocumentParseError("Test", DocumentParseError.ENCRYPTED_PDF)
        assert error.error_code == "encrypted_pdf"

        # Test legacy doc
        error = DocumentParseError("Test", DocumentParseError.LEGACY_DOC)
        assert error.error_code == "legacy_doc"

        # Test legacy ppt
        error = DocumentParseError("Test", DocumentParseError.LEGACY_PPT)
        assert error.error_code == "legacy_ppt"

        # Test legacy xls
        error = DocumentParseError("Test", DocumentParseError.LEGACY_XLS)
        assert error.error_code == "legacy_xls"

        # Test default error code
        error = DocumentParseError("Test")
        assert error.error_code == "parse_failed"

    def test_parse_legacy_doc_raises_error(self):
        """Test that parsing .doc file raises DocumentParseError with correct code."""
        with pytest.raises(DocumentParseError) as exc_info:
            self.parser.parse(b"some content", ".doc")
        assert exc_info.value.error_code == DocumentParseError.LEGACY_DOC

    def test_parse_legacy_ppt_raises_error(self):
        """Test that parsing .ppt file raises DocumentParseError with correct code."""
        with pytest.raises(DocumentParseError) as exc_info:
            self.parser.parse(b"some content", ".ppt")
        assert exc_info.value.error_code == DocumentParseError.LEGACY_PPT

    def test_parse_legacy_xls_raises_error(self):
        """Test that parsing .xls file raises DocumentParseError with correct code."""
        with pytest.raises(DocumentParseError) as exc_info:
            self.parser.parse(b"some content", ".xls")
        assert exc_info.value.error_code == DocumentParseError.LEGACY_XLS


class TestTruncationInfo:
    """Test cases for TruncationInfo dataclass."""

    def test_truncation_info_defaults(self):
        """Test TruncationInfo default values."""
        info = TruncationInfo()
        assert info.is_truncated is False
        assert info.original_length is None
        assert info.truncated_length is None

    def test_truncation_info_with_values(self):
        """Test TruncationInfo with values."""
        info = TruncationInfo(
            is_truncated=True, original_length=2000000, truncated_length=1500000
        )
        assert info.is_truncated is True
        assert info.original_length == 2000000
        assert info.truncated_length == 1500000


class TestParseResult:
    """Test cases for ParseResult dataclass."""

    def test_parse_result_basic(self):
        """Test ParseResult with basic values."""
        result = ParseResult(text="Hello", text_length=5)
        assert result.text == "Hello"
        assert result.text_length == 5
        assert result.image_base64 is None
        assert result.truncation_info is None

    def test_parse_result_with_truncation(self):
        """Test ParseResult with truncation info."""
        truncation = TruncationInfo(
            is_truncated=True, original_length=100, truncated_length=50
        )
        result = ParseResult(text="Hello", text_length=5, truncation_info=truncation)
        assert result.truncation_info is not None
        assert result.truncation_info.is_truncated is True

    def test_parse_result_with_image(self):
        """Test ParseResult with image base64."""
        result = ParseResult(text="Image", text_length=5, image_base64="base64data")
        assert result.image_base64 == "base64data"
