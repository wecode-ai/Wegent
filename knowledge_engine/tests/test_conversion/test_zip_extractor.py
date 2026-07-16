# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ZIP extractor."""

import io
import zipfile
from unittest.mock import MagicMock, patch

import pytest

from knowledge_engine.conversion.zip_extractor import (
    ExtractionResult,
    extract_markdown_from_zip,
)


def _make_zip(files: dict) -> bytes:
    """Helper: create a ZIP with given filename->content mapping."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, content in files.items():
            if isinstance(content, str):
                z.writestr(name, content)
            else:
                z.writestr(name, content)
    return buf.getvalue()


def test_extract_markdown_basic():
    zip_bytes = _make_zip({"document.md": "# Hello\nWorld"})
    result = extract_markdown_from_zip(zip_bytes)
    assert isinstance(result, ExtractionResult)
    assert result.markdown_bytes == b"# Hello\nWorld"
    assert result.uploaded_images == []


def test_extract_markdown_no_md_raises():
    zip_bytes = _make_zip({"document.txt": "plain text"})
    with pytest.raises(RuntimeError, match="No markdown file"):
        extract_markdown_from_zip(zip_bytes)


def test_extract_markdown_bad_zip_raises():
    with pytest.raises(RuntimeError, match="Invalid ZIP"):
        extract_markdown_from_zip(b"not_a_zip_content")


def test_extract_markdown_no_s3_leaves_refs_unchanged():
    """Without S3 uploader, image refs stay as-is."""
    md = "# Doc\n![img](images/test.png)"
    zip_bytes = _make_zip({"document.md": md, "images/test.png": b"\x89PNG"})
    result = extract_markdown_from_zip(zip_bytes)
    assert "images/test.png" in result.markdown_bytes.decode()


def test_extract_markdown_disabled_s3_leaves_refs_unchanged():
    """S3 uploader disabled: image refs stay unchanged."""
    from knowledge_engine.conversion.s3_uploader import S3Config, S3Uploader

    md = "# Doc\n![img](images/test.png)"
    zip_bytes = _make_zip({"document.md": md, "images/test.png": b"\x89PNG"})

    uploader = S3Uploader(S3Config(enabled=False))
    result = extract_markdown_from_zip(
        zip_bytes, s3_uploader=uploader, s3_base_path="kb/doc"
    )
    assert "images/test.png" in result.markdown_bytes.decode()
    assert result.uploaded_images == []


def test_extract_markdown_replaces_md_image_refs():
    """S3 uploader enabled: ![alt](path) refs replaced with S3 URLs."""
    from knowledge_engine.conversion.s3_uploader import S3Config, S3Uploader

    md = "# Doc\n![fig](images/fig1.png)"
    zip_bytes = _make_zip({"document.md": md, "images/fig1.png": b"\x89PNG"})

    config = S3Config(enabled=True, endpoint="http://minio:9000", bucket_name="docs")
    uploader = S3Uploader(config)

    with patch("boto3.client") as mock_boto3:
        mock_s3 = MagicMock()
        mock_boto3.return_value = mock_s3

        result = extract_markdown_from_zip(
            zip_bytes, s3_uploader=uploader, s3_base_path="mykb/mydoc"
        )
        md_text = result.markdown_bytes.decode()
        assert "http://minio:9000" in md_text
        # Original bare local ref should be replaced; the S3 URL may still
        # contain the filename as part of its path, so only check the pattern
        # "![fig](images/fig1.png)" (without http prefix) is gone.
        assert "![fig](images/fig1.png)" not in md_text
        assert len(result.uploaded_images) == 1


def test_extract_markdown_skips_http_urls():
    """HTTP image refs are not processed."""
    md = "# Doc\n![ext](https://example.com/img.png)"
    zip_bytes = _make_zip({"document.md": md})
    result = extract_markdown_from_zip(zip_bytes)
    assert "https://example.com/img.png" in result.markdown_bytes.decode()
