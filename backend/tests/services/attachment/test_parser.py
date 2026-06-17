# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the document parser service.
"""

import base64
import io
import json
import zipfile
from unittest.mock import MagicMock, patch

import pytest

from app.services.attachment.parser import (
    TEXT_MIME_TYPES,
    DocumentParseError,
    DocumentParser,
    ParseResult,
    TruncationInfo,
)


def _build_xmind_archive() -> bytes:
    """Build a minimal XMind archive for parser tests."""
    content = [
        {
            "title": "Planning",
            "rootTopic": {
                "title": "Roadmap",
                "children": {
                    "attached": [
                        {"title": "Discovery"},
                        {"title": "Implementation"},
                    ]
                },
            },
        }
    ]
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("content.json", json.dumps(content))
    return archive.getvalue()


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
            ".xmind",
        ]
        for ext in expected_extensions:
            assert self.parser.is_supported_extension(
                ext
            ), f"Extension {ext} should be supported"

    def test_unknown_extension_allowed_for_mime_detection(self):
        """Test that unknown extensions are allowed (for MIME detection)."""
        # Now all extensions return True because MIME detection will validate
        unknown_extensions = [".py", ".js", ".java", ".go", ".rs"]
        for ext in unknown_extensions:
            assert self.parser.is_supported_extension(
                ext
            ), f"Extension {ext} should be allowed for MIME detection"

    def test_is_known_extension(self):
        """Test is_known_extension method."""
        # Known extensions
        assert self.parser.is_known_extension(".pdf") is True
        assert self.parser.is_known_extension(".txt") is True
        assert self.parser.is_known_extension(".jpg") is True

        # Unknown extensions
        assert self.parser.is_known_extension(".py") is False
        assert self.parser.is_known_extension(".js") is False
        assert self.parser.is_known_extension(".exe") is False

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

    def test_parse_binary_file_raises_unrecognized_type_error(self):
        """Test that parsing binary file with unknown extension raises UNRECOGNIZED_TYPE."""
        # Create binary content that will be detected as binary
        binary_content = bytes([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD])
        with pytest.raises(DocumentParseError) as exc_info:
            self.parser.parse(binary_content, ".exe")
        assert exc_info.value.error_code == DocumentParseError.UNRECOGNIZED_TYPE

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

    def test_parse_xmind_file_extracts_topics_as_markdown(self):
        """Test parsing XMind mind-map topics into Markdown text."""
        result = self.parser.parse(_build_xmind_archive(), ".xmind")

        assert isinstance(result, ParseResult)
        assert "# Planning" in result.text
        assert "- Roadmap" in result.text
        assert "Discovery" in result.text
        assert "Implementation" in result.text
        assert result.text_length == len(result.text)
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
        assert result.image_mime_type is None

    def test_parse_result_with_image_mime_type(self):
        """Test ParseResult with image_mime_type set."""
        result = ParseResult(
            text="Image",
            text_length=5,
            image_base64="base64data",
            image_mime_type="image/jpeg",
        )
        assert result.image_mime_type == "image/jpeg"


class TestMimeTypeDetection:
    """Test cases for MIME type detection functionality."""

    def setup_method(self):
        """Set up test fixtures."""
        self.parser = DocumentParser()

    def test_detect_mime_type_text_plain(self):
        """Test MIME detection for plain text content."""
        content = b"Hello, this is plain text content."
        mime_type = self.parser.detect_mime_type(content)
        assert mime_type.startswith("text/")

    def test_detect_mime_type_json(self):
        """Test MIME detection for JSON content."""
        content = b'{"key": "value", "number": 123}'
        mime_type = self.parser.detect_mime_type(content)
        assert mime_type in ["application/json", "text/plain", "text/json"]

    def test_detect_mime_type_python(self):
        """Test MIME detection for Python code."""
        content = b"""#!/usr/bin/env python3
def hello():
    print("Hello, World!")

if __name__ == "__main__":
    hello()
"""
        mime_type = self.parser.detect_mime_type(content)
        # Python files are detected as text/x-python or text/x-script.python or text/plain
        assert mime_type.startswith("text/")

    def test_detect_mime_type_binary(self):
        """Test MIME detection for binary content."""
        # Create a minimal valid GIF87a image that libmagic reliably detects as binary
        # GIF87a magic bytes followed by minimal valid header
        gif_data = (
            b"GIF87a"  # GIF magic + version
            b"\x01\x00\x01\x00"  # width=1, height=1
            b"\x80\x00\x00"  # GCT flag, background, aspect ratio
            b"\xff\xff\xff\x00\x00\x00"  # 2-color GCT
            b",\x00\x00\x00\x00\x01\x00\x01\x00\x00"  # image descriptor
            b"\x02\x02\x44\x01\x00"  # LZW min code size + data
            b"\x3b"  # trailer
        )
        mime_type = self.parser.detect_mime_type(gif_data)
        # GIF data is reliably detected as image/gif across libmagic versions
        assert not mime_type.startswith("text/")

    def test_is_text_mime_type_text_family(self):
        """Test is_text_mime_type for text/* MIME types."""
        assert DocumentParser.is_text_mime_type("text/plain") is True
        assert DocumentParser.is_text_mime_type("text/html") is True
        assert DocumentParser.is_text_mime_type("text/css") is True
        assert DocumentParser.is_text_mime_type("text/javascript") is True
        assert DocumentParser.is_text_mime_type("text/x-python") is True
        assert DocumentParser.is_text_mime_type("text/x-java") is True

    def test_is_text_mime_type_application_text_types(self):
        """Test is_text_mime_type for text-based application/* types."""
        assert DocumentParser.is_text_mime_type("application/json") is True
        assert DocumentParser.is_text_mime_type("application/xml") is True
        assert DocumentParser.is_text_mime_type("application/javascript") is True
        assert DocumentParser.is_text_mime_type("application/x-sh") is True
        assert DocumentParser.is_text_mime_type("application/yaml") is True

    def test_is_text_mime_type_json_xml_suffix(self):
        """Test is_text_mime_type for types with +json or +xml suffix."""
        assert DocumentParser.is_text_mime_type("application/ld+json") is True
        assert DocumentParser.is_text_mime_type("application/vnd.api+json") is True
        assert DocumentParser.is_text_mime_type("application/atom+xml") is True
        assert DocumentParser.is_text_mime_type("application/rss+xml") is True

    def test_is_text_mime_type_binary_types(self):
        """Test is_text_mime_type for binary types (should return False)."""
        assert DocumentParser.is_text_mime_type("application/octet-stream") is False
        assert DocumentParser.is_text_mime_type("application/zip") is False
        assert DocumentParser.is_text_mime_type("application/pdf") is False
        assert DocumentParser.is_text_mime_type("image/jpeg") is False
        assert DocumentParser.is_text_mime_type("audio/mpeg") is False

    def test_is_text_mime_type_empty_or_none(self):
        """Test is_text_mime_type with empty or None values."""
        assert DocumentParser.is_text_mime_type("") is False
        assert DocumentParser.is_text_mime_type(None) is False

    def test_parse_code_file_with_text_mime(self):
        """Test parsing code file that is detected as text via MIME."""
        python_code = b'''def calculate_sum(a, b):
    """Calculate the sum of two numbers."""
    return a + b

result = calculate_sum(10, 20)
print(f"Result: {result}")
'''
        # Parse with unknown extension - should work via MIME detection
        result = self.parser.parse(python_code, ".py")
        assert isinstance(result, ParseResult)
        assert "calculate_sum" in result.text
        assert "def " in result.text

    def test_parse_json_file_with_unknown_extension(self):
        """Test parsing JSON content with unknown extension."""
        json_content = b'{"name": "test", "value": 123, "active": true}'
        result = self.parser.parse(json_content, ".json")
        assert isinstance(result, ParseResult)
        assert "test" in result.text
        assert "123" in result.text

    def test_parse_yaml_file(self):
        """Test parsing YAML content."""
        yaml_content = b"""name: test
version: 1.0.0
dependencies:
  - package1
  - package2
"""
        result = self.parser.parse(yaml_content, ".yaml")
        assert isinstance(result, ParseResult)
        assert "name:" in result.text
        assert "dependencies:" in result.text

    def test_parse_shell_script(self):
        """Test parsing shell script content."""
        shell_content = b"""#!/bin/bash
echo "Hello, World!"
for i in 1 2 3; do
    echo "Number: $i"
done
"""
        result = self.parser.parse(shell_content, ".sh")
        assert isinstance(result, ParseResult)
        assert "#!/bin/bash" in result.text
        assert "echo" in result.text

    def test_unrecognized_type_error_code(self):
        """Test that UNRECOGNIZED_TYPE error code is set correctly."""
        error = DocumentParseError("Test", DocumentParseError.UNRECOGNIZED_TYPE)
        assert error.error_code == "unrecognized_type"

    def test_text_mime_types_constant(self):
        """Test that TEXT_MIME_TYPES contains expected types."""
        assert "text/plain" in TEXT_MIME_TYPES


def _make_image_bytes(fmt: str, mode: str = "RGB") -> bytes:
    """Create minimal valid image bytes in the given PIL format."""
    from PIL import Image

    img = Image.new(mode, (4, 4), color=0)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _make_image_bytes_sized(width: int, height: int, fmt: str = "JPEG") -> bytes:
    """Create valid image bytes with the given pixel dimensions."""
    from PIL import Image

    img = Image.new("RGB", (width, height), color="blue")
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _decoded_dimensions(image_base64: str) -> tuple[int, int]:
    """Return (width, height) from a base64-encoded image."""
    from PIL import Image

    img = Image.open(io.BytesIO(base64.b64decode(image_base64)))
    return img.size


class TestImageParsing:
    """Test image format normalisation in DocumentParser."""

    def setup_method(self):
        self.parser = DocumentParser()

    def test_jpeg_preserved_without_conversion(self):
        """JPEG images must be stored as-is; mime_type stays image/jpeg."""
        jpeg_bytes = _make_image_bytes("JPEG")
        result = self.parser.parse(jpeg_bytes, ".jpg")

        assert result.image_mime_type == "image/jpeg"
        decoded = base64.b64decode(result.image_base64)
        assert decoded[:2] == b"\xff\xd8"  # JPEG SOI marker

    def test_png_preserved_without_conversion(self):
        """PNG images must be stored as-is; mime_type stays image/png."""
        png_bytes = _make_image_bytes("PNG")
        result = self.parser.parse(png_bytes, ".png")

        assert result.image_mime_type == "image/png"
        decoded = base64.b64decode(result.image_base64)
        assert decoded[:4] == b"\x89PNG"  # PNG signature

    def test_webp_preserved_without_conversion(self):
        """WebP images must be stored as-is; mime_type stays image/webp."""
        webp_bytes = _make_image_bytes("WEBP")
        result = self.parser.parse(webp_bytes, ".webp")

        assert result.image_mime_type == "image/webp"
        decoded = base64.b64decode(result.image_base64)
        assert decoded[8:12] == b"WEBP"  # WebP RIFF sub-chunk

    def test_gif_converted_to_jpeg(self):
        """GIF (not in three-way intersection) must be converted to JPEG."""
        gif_bytes = _make_image_bytes("GIF", mode="P")
        result = self.parser.parse(gif_bytes, ".gif")

        assert result.image_mime_type == "image/jpeg"
        decoded = base64.b64decode(result.image_base64)
        assert decoded[:2] == b"\xff\xd8"  # JPEG SOI marker

    def test_bmp_converted_to_jpeg(self):
        """BMP (not in three-way intersection) must be converted to JPEG."""
        bmp_bytes = _make_image_bytes("BMP")
        result = self.parser.parse(bmp_bytes, ".bmp")

        assert result.image_mime_type == "image/jpeg"
        decoded = base64.b64decode(result.image_base64)
        assert decoded[:2] == b"\xff\xd8"  # JPEG SOI marker

    def test_vision_supported_extensions_constant(self):
        """VISION_SUPPORTED_EXTENSIONS must contain exactly the three-API intersection."""
        expected = {".jpg", ".jpeg", ".png", ".webp"}
        assert DocumentParser.VISION_SUPPORTED_EXTENSIONS == expected
        assert "application/json" in TEXT_MIME_TYPES
        assert "application/xml" in TEXT_MIME_TYPES
        assert "text/x-python" in TEXT_MIME_TYPES

    # ------------------------------------------------------------------
    # Dimension enforcement (MAX_IMAGE_LONG_EDGE)
    # ------------------------------------------------------------------

    def test_jpeg_within_limit_stored_as_original_bytes(self):
        """JPEG with all dimensions within limit is stored without re-encoding."""
        from app.services.attachment.parser import MAX_IMAGE_LONG_EDGE

        jpeg_bytes = _make_image_bytes_sized(MAX_IMAGE_LONG_EDGE, 100)
        result = self.parser.parse(jpeg_bytes, ".jpg")

        assert result.image_mime_type == "image/jpeg"
        # Original bytes round-trip: decoded base64 equals input.
        assert base64.b64decode(result.image_base64) == jpeg_bytes

    def test_tall_jpeg_is_resized(self):
        """Tall JPEG (height > 1568px) is resized so the long edge fits within the limit."""
        from app.services.attachment.parser import MAX_IMAGE_LONG_EDGE

        jpeg_bytes = _make_image_bytes_sized(100, 13768)
        result = self.parser.parse(jpeg_bytes, ".jpg")

        assert result.image_mime_type == "image/jpeg"
        w, h = _decoded_dimensions(result.image_base64)
        assert max(w, h) <= MAX_IMAGE_LONG_EDGE

    def test_wide_jpeg_is_resized(self):
        """Wide JPEG (width > 1568px) is resized so the long edge fits within the limit."""
        from app.services.attachment.parser import MAX_IMAGE_LONG_EDGE

        jpeg_bytes = _make_image_bytes_sized(9000, 100)
        result = self.parser.parse(jpeg_bytes, ".jpg")

        assert result.image_mime_type == "image/jpeg"
        w, h = _decoded_dimensions(result.image_base64)
        assert max(w, h) <= MAX_IMAGE_LONG_EDGE

    def test_oversized_jpeg_aspect_ratio_preserved(self):
        """Resized JPEG maintains aspect ratio (within 1px rounding tolerance)."""
        from app.services.attachment.parser import MAX_IMAGE_LONG_EDGE

        orig_w, orig_h = 100, 9000  # 1:90 ratio
        jpeg_bytes = _make_image_bytes_sized(orig_w, orig_h)
        result = self.parser.parse(jpeg_bytes, ".jpg")

        out_w, out_h = _decoded_dimensions(result.image_base64)
        expected_w = max(1, int(orig_w * MAX_IMAGE_LONG_EDGE / max(orig_w, orig_h)))
        assert abs(out_w - expected_w) <= 1

    def test_oversized_jpeg_metadata_reflects_stored_dimensions(self):
        """Metadata text reports the post-resize dimensions, not the original ones."""
        jpeg_bytes = _make_image_bytes_sized(100, 13768)
        result = self.parser.parse(jpeg_bytes, ".jpg")

        # The metadata text should NOT say "13768"
        assert "13768" not in result.text
        # The stored dimensions should appear instead
        w, h = _decoded_dimensions(result.image_base64)
        assert f"{w} x {h}" in result.text

    def test_oversized_png_is_resized_and_reencoded_as_jpeg(self):
        """PNG with dimension > 1568px is resized and re-encoded as JPEG."""
        from app.services.attachment.parser import MAX_IMAGE_LONG_EDGE

        png_bytes = _make_image_bytes_sized(100, 9000, fmt="PNG")
        result = self.parser.parse(png_bytes, ".png")

        assert result.image_mime_type == "image/jpeg"
        w, h = _decoded_dimensions(result.image_base64)
        assert max(w, h) <= MAX_IMAGE_LONG_EDGE

    def test_oversized_webp_is_resized(self):
        """WebP image with dimension > 1568px is resized."""
        from app.services.attachment.parser import MAX_IMAGE_LONG_EDGE

        webp_bytes = _make_image_bytes_sized(9000, 100, fmt="WEBP")
        result = self.parser.parse(webp_bytes, ".webp")

        assert result.image_mime_type == "image/jpeg"
        w, h = _decoded_dimensions(result.image_base64)
        assert max(w, h) <= MAX_IMAGE_LONG_EDGE
