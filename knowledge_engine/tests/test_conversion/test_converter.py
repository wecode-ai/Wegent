# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for unified converter entry point."""

import io
import zipfile
from unittest.mock import patch

import pytest

from knowledge_engine.conversion.converter import ConversionResult, convert_document
from knowledge_engine.conversion.mineru_client import MinerUConfig


def _make_zip_with_md(md_content: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("document.md", md_content)
    return buf.getvalue()


def test_convert_document_unsupported_extension():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    with pytest.raises(RuntimeError, match="not supported"):
        convert_document(b"data", "txt", config)


def test_convert_document_unsupported_extension_jpg():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    with pytest.raises(RuntimeError, match="not supported"):
        convert_document(b"data", ".jpg", config)


def test_convert_document_success_pdf():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = _make_zip_with_md("# Converted PDF")

    with patch(
        "knowledge_engine.conversion.converter.asyncio.run", return_value=zip_bytes
    ):
        result = convert_document(b"pdf_bytes", "pdf", config)

    assert isinstance(result, ConversionResult)
    assert result.markdown_bytes == b"# Converted PDF"
    assert result.uploaded_images == []


def test_convert_document_success_with_dot_extension():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = _make_zip_with_md("# Converted DOCX")

    with patch(
        "knowledge_engine.conversion.converter.asyncio.run", return_value=zip_bytes
    ):
        result = convert_document(b"docx_bytes", ".docx", config)

    assert result.markdown_bytes == b"# Converted DOCX"


def test_convert_document_result_is_frozen():
    """ConversionResult is a frozen dataclass."""
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = _make_zip_with_md("# Test")

    with patch(
        "knowledge_engine.conversion.converter.asyncio.run", return_value=zip_bytes
    ):
        result = convert_document(b"data", "pptx", config)

    with pytest.raises((AttributeError, TypeError)):
        result.markdown_bytes = b"tamper"  # type: ignore[misc]
