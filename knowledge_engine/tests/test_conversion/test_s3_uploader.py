# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for S3 uploader."""

import threading
from unittest.mock import MagicMock, patch

import pytest

from knowledge_engine.conversion.s3_uploader import S3Config, S3Uploader


def test_uploader_disabled_returns_none():
    config = S3Config(enabled=False)
    uploader = S3Uploader(config)
    result = uploader.upload_image(b"image_data", "test/image.png")
    assert result is None


def test_uploader_enabled_property():
    assert S3Uploader(S3Config(enabled=True)).enabled is True
    assert S3Uploader(S3Config(enabled=False)).enabled is False


def test_uploader_has_lock():
    uploader = S3Uploader(S3Config())
    assert hasattr(uploader, "_lock")
    assert isinstance(uploader._lock, type(threading.Lock()))


def test_upload_image_returns_url():
    config = S3Config(
        enabled=True,
        endpoint="http://minio:9000",
        access_key="key",
        secret_key="secret",
        bucket_name="test-bucket",
    )
    uploader = S3Uploader(config)

    with patch("boto3.client") as mock_boto3:
        mock_s3 = MagicMock()
        mock_boto3.return_value = mock_s3
        mock_s3.upload_fileobj = MagicMock()

        url = uploader.upload_image(b"img", "kb/doc/images/pic.png")
        assert url == "http://minio:9000/test-bucket/kb/doc/images/pic.png"
        mock_s3.upload_fileobj.assert_called_once()


def test_upload_image_encodes_chinese_path():
    config = S3Config(
        enabled=True,
        endpoint="http://minio:9000",
        bucket_name="docs",
    )
    uploader = S3Uploader(config)

    with patch("boto3.client") as mock_boto3:
        mock_s3 = MagicMock()
        mock_boto3.return_value = mock_s3

        url = uploader.upload_image(b"img", "知识库/文档/images/pic.jpg")
        # "知识库" URL-encoded
        assert "%E7%9F%A5%E8%AF%86%E5%BA%93" in url


def test_upload_image_returns_none_on_error():
    config = S3Config(
        enabled=True,
        endpoint="http://minio:9000",
        bucket_name="docs",
    )
    uploader = S3Uploader(config)

    with patch("boto3.client") as mock_boto3:
        mock_s3 = MagicMock()
        mock_boto3.return_value = mock_s3
        mock_s3.upload_fileobj.side_effect = Exception("S3 error")

        result = uploader.upload_image(b"img", "test/img.png")
        assert result is None
