# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for unified converter entry point."""

import io
import zipfile
from unittest.mock import patch
from xml.etree import ElementTree

import pytest

from knowledge_engine.conversion.converter import ConversionResult, convert_document
from knowledge_engine.conversion.mineru_client import MinerUConfig


def _make_zip_with_md(md_content: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("document.md", md_content)
    return buf.getvalue()


def _make_minimal_epub() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
            <container version="1.0"
              xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles>
                <rootfile full-path="OPS/content.opf"
                  media-type="application/oebps-package+xml"/>
              </rootfiles>
            </container>""",
        )
        z.writestr(
            "OPS/content.opf",
            """<?xml version="1.0"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
              <manifest>
                <item id="chapter1" href="chapter1.xhtml"
                  media-type="application/xhtml+xml"/>
              </manifest>
              <spine>
                <itemref idref="chapter1"/>
              </spine>
            </package>""",
        )
        z.writestr(
            "OPS/chapter1.xhtml",
            "<html><body><h1>Chapter One</h1><p>Hello EPUB.</p></body></html>",
        )
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

    async def fake_submit_and_wait(*args, **kwargs):
        return zip_bytes

    with patch(
        "knowledge_engine.conversion.converter.submit_and_wait",
        side_effect=fake_submit_and_wait,
    ):
        result = convert_document(b"pdf_bytes", "pdf", config)

    assert isinstance(result, ConversionResult)
    assert result.markdown_bytes == b"# Converted PDF"
    assert result.uploaded_images == []


def test_convert_document_success_with_dot_extension():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = _make_zip_with_md("# Converted DOCX")

    async def fake_submit_and_wait(*args, **kwargs):
        return zip_bytes

    with patch(
        "knowledge_engine.conversion.converter.submit_and_wait",
        side_effect=fake_submit_and_wait,
    ):
        result = convert_document(b"docx_bytes", ".docx", config)

    assert result.markdown_bytes == b"# Converted DOCX"


def test_convert_document_converts_legacy_office_before_mineru():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = _make_zip_with_md("# Converted DOC")
    submitted = {}

    async def fake_submit_and_wait(binary_data, file_extension, mineru_config):
        submitted["binary_data"] = binary_data
        submitted["file_extension"] = file_extension
        submitted["mineru_config"] = mineru_config
        return zip_bytes

    with (
        patch(
            "knowledge_engine.conversion.converter.convert_legacy_office_to_openxml",
            return_value=(b"docx_bytes", "docx"),
        ) as mock_legacy_convert,
        patch(
            "knowledge_engine.conversion.converter.submit_and_wait",
            side_effect=fake_submit_and_wait,
        ),
    ):
        result = convert_document(b"doc_bytes", "doc", config)

    mock_legacy_convert.assert_called_once_with(b"doc_bytes", "doc")
    assert submitted["binary_data"] == b"docx_bytes"
    assert submitted["file_extension"] == "docx"
    assert submitted["mineru_config"] is config
    assert result.markdown_bytes == b"# Converted DOC"


def test_convert_document_local_epub():
    config = MinerUConfig(api_base_url="http://mineru:8367")

    result = convert_document(_make_minimal_epub(), "epub", config)

    assert b"Chapter One" in result.markdown_bytes
    assert b"Hello EPUB" in result.markdown_bytes
    assert result.uploaded_images == []


def test_convert_document_local_eml():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    eml = (
        b"Subject: Roadmap\n"
        b"From: alice@example.com\n"
        b"To: bob@example.com\n"
        b"Content-Type: text/plain; charset=utf-8\n"
        b"\n"
        b"Ship the parser upgrade."
    )

    result = convert_document(eml, "eml", config)

    assert b"# Roadmap" in result.markdown_bytes
    assert b"Ship the parser upgrade." in result.markdown_bytes


def test_convert_document_local_html():
    config = MinerUConfig(api_base_url="http://mineru:8367")

    result = convert_document(
        b"<html><body><h1>Title</h1><p>Body text.</p></body></html>",
        "html",
        config,
    )

    assert b"Title" in result.markdown_bytes
    assert b"Body text" in result.markdown_bytes


def test_convert_document_local_xml():
    config = MinerUConfig(api_base_url="http://mineru:8367")
    xml_bytes = ElementTree.tostring(
        ElementTree.fromstring("<root><item>Value</item></root>")
    )

    result = convert_document(xml_bytes, "xml", config)

    assert b"XML Document" in result.markdown_bytes
    assert b"Value" in result.markdown_bytes


def test_convert_document_result_is_frozen():
    """ConversionResult is a frozen dataclass."""
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = _make_zip_with_md("# Test")

    async def fake_submit_and_wait(*args, **kwargs):
        return zip_bytes

    with patch(
        "knowledge_engine.conversion.converter.submit_and_wait",
        side_effect=fake_submit_and_wait,
    ):
        result = convert_document(b"data", "pptx", config)

    with pytest.raises((AttributeError, TypeError)):
        result.markdown_bytes = b"tamper"  # type: ignore[misc]
