# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for S3 client utility.
"""

import os
import sys
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from shared.utils.s3_client import (
    S3Client,
    S3Config,
    get_workspace_archive_s3_client,
    is_workspace_archive_enabled,
)


class TestS3Config:
    """Test S3Config class."""

    def test_from_env_valid_config(self):
        """Test creating config from valid environment variables."""
        with patch.dict(
            os.environ,
            {
                "TEST_S3_ENDPOINT": "http://localhost:9000",
                "TEST_S3_BUCKET": "test-bucket",
                "TEST_S3_ACCESS_KEY": "test-access-key",
                "TEST_S3_SECRET_KEY": "test-secret-key",
                "TEST_S3_REGION": "us-west-2",
            },
        ):
            config = S3Config.from_env("TEST_S3")
            assert config is not None
            assert config.endpoint == "http://localhost:9000"
            assert config.bucket == "test-bucket"
            assert config.access_key == "test-access-key"
            assert config.secret_key == "test-secret-key"
            assert config.region == "us-west-2"
            assert config.is_valid()

    def test_from_env_missing_required(self):
        """Test creating config with missing required variables."""
        with patch.dict(
            os.environ,
            {
                "TEST_S3_ENDPOINT": "http://localhost:9000",
                # Missing bucket, access_key, secret_key
            },
            clear=True,
        ):
            config = S3Config.from_env("TEST_S3")
            assert config is None

    def test_from_env_defaults(self):
        """Test default values for optional fields."""
        with patch.dict(
            os.environ,
            {
                "TEST_S3_ENDPOINT": "http://localhost:9000",
                "TEST_S3_BUCKET": "test-bucket",
                "TEST_S3_ACCESS_KEY": "test-access-key",
                "TEST_S3_SECRET_KEY": "test-secret-key",
            },
        ):
            config = S3Config.from_env("TEST_S3")
            assert config is not None
            assert config.region == "us-east-1"  # Default
            assert config.use_ssl is True  # Default

    def test_is_valid(self):
        """Test is_valid method."""
        valid_config = S3Config(
            endpoint="http://localhost:9000",
            bucket="test-bucket",
            access_key="test-key",
            secret_key="test-secret",
        )
        assert valid_config.is_valid()

        invalid_config = S3Config(
            endpoint="",
            bucket="test-bucket",
            access_key="test-key",
            secret_key="test-secret",
        )
        assert not invalid_config.is_valid()


class TestS3Client:
    """Test S3Client class."""

    @pytest.fixture
    def s3_config(self):
        """Create S3Config for tests."""
        return S3Config(
            endpoint="http://localhost:9000",
            bucket="test-bucket",
            access_key="test-key",
            secret_key="test-secret",
        )

    @pytest.fixture
    def mock_boto3_module(self):
        """Mock boto3 module before import."""
        mock_boto3 = MagicMock()
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        sys.modules["boto3"] = mock_boto3
        sys.modules["botocore"] = MagicMock()
        sys.modules["botocore.config"] = MagicMock()
        yield mock_boto3, mock_client
        # Cleanup
        if "boto3" in sys.modules:
            del sys.modules["boto3"]
        if "botocore" in sys.modules:
            del sys.modules["botocore"]
        if "botocore.config" in sys.modules:
            del sys.modules["botocore.config"]

    def test_upload_bytes_success(self, s3_config, mock_boto3_module):
        """Test successful bytes upload."""
        mock_boto3, mock_client = mock_boto3_module

        client = S3Client(s3_config)
        result = client.upload_bytes(b"test data", "test-key")

        assert result is True
        mock_client.upload_fileobj.assert_called_once()

    def test_upload_bytes_failure(self, s3_config, mock_boto3_module):
        """Test failed bytes upload."""
        mock_boto3, mock_client = mock_boto3_module
        mock_client.upload_fileobj.side_effect = Exception("Upload failed")

        client = S3Client(s3_config)
        result = client.upload_bytes(b"test data", "test-key")

        assert result is False

    def test_download_bytes_success(self, s3_config, mock_boto3_module):
        """Test successful bytes download."""
        mock_boto3, mock_client = mock_boto3_module
        test_data = b"test data"

        def mock_download(bucket, key, fileobj):
            fileobj.write(test_data)

        mock_client.download_fileobj.side_effect = mock_download

        client = S3Client(s3_config)
        result = client.download_bytes("test-key")

        assert result == test_data

    def test_download_bytes_failure(self, s3_config, mock_boto3_module):
        """Test failed bytes download."""
        mock_boto3, mock_client = mock_boto3_module
        mock_client.download_fileobj.side_effect = Exception("Download failed")

        client = S3Client(s3_config)
        result = client.download_bytes("test-key")

        assert result is None

    def test_delete_success(self, s3_config, mock_boto3_module):
        """Test successful object deletion."""
        mock_boto3, mock_client = mock_boto3_module

        client = S3Client(s3_config)
        result = client.delete("test-key")

        assert result is True
        mock_client.delete_object.assert_called_once_with(
            Bucket="test-bucket", Key="test-key"
        )

    def test_exists_true(self, s3_config, mock_boto3_module):
        """Test object exists."""
        mock_boto3, mock_client = mock_boto3_module

        client = S3Client(s3_config)
        result = client.exists("test-key")

        assert result is True
        mock_client.head_object.assert_called_once()

    def test_exists_false(self, s3_config, mock_boto3_module):
        """Test object does not exist."""
        mock_boto3, mock_client = mock_boto3_module
        mock_client.head_object.side_effect = Exception("Not found")

        client = S3Client(s3_config)
        result = client.exists("test-key")

        assert result is False


class TestHelperFunctions:
    """Test helper functions."""

    def test_is_workspace_archive_enabled_true(self):
        """Test workspace archive is enabled when properly configured."""
        with patch.dict(
            os.environ,
            {
                "WORKSPACE_ARCHIVE_ENABLED": "true",
                "WORKSPACE_ARCHIVE_S3_ENDPOINT": "http://localhost:9000",
                "WORKSPACE_ARCHIVE_S3_BUCKET": "test-bucket",
                "WORKSPACE_ARCHIVE_S3_ACCESS_KEY": "test-key",
                "WORKSPACE_ARCHIVE_S3_SECRET_KEY": "test-secret",
            },
        ):
            assert is_workspace_archive_enabled() is True

    def test_is_workspace_archive_enabled_false_disabled(self):
        """Test workspace archive is disabled when WORKSPACE_ARCHIVE_ENABLED is false."""
        with patch.dict(
            os.environ,
            {
                "WORKSPACE_ARCHIVE_ENABLED": "false",
                "WORKSPACE_ARCHIVE_S3_ENDPOINT": "http://localhost:9000",
                "WORKSPACE_ARCHIVE_S3_BUCKET": "test-bucket",
                "WORKSPACE_ARCHIVE_S3_ACCESS_KEY": "test-key",
                "WORKSPACE_ARCHIVE_S3_SECRET_KEY": "test-secret",
            },
        ):
            assert is_workspace_archive_enabled() is False

    def test_is_workspace_archive_enabled_false_missing_config(self):
        """Test workspace archive is disabled when S3 config is missing."""
        with patch.dict(
            os.environ,
            {
                "WORKSPACE_ARCHIVE_ENABLED": "true",
                # Missing S3 config
            },
            clear=True,
        ):
            assert is_workspace_archive_enabled() is False

    def test_get_workspace_archive_s3_client_configured(self):
        """Test getting S3 client when properly configured."""
        with patch.dict(
            os.environ,
            {
                "WORKSPACE_ARCHIVE_S3_ENDPOINT": "http://localhost:9000",
                "WORKSPACE_ARCHIVE_S3_BUCKET": "test-bucket",
                "WORKSPACE_ARCHIVE_S3_ACCESS_KEY": "test-key",
                "WORKSPACE_ARCHIVE_S3_SECRET_KEY": "test-secret",
            },
        ):
            client = get_workspace_archive_s3_client()
            assert client is not None
            assert isinstance(client, S3Client)

    def test_get_workspace_archive_s3_client_not_configured(self):
        """Test getting S3 client when not configured."""
        with patch.dict(os.environ, {}, clear=True):
            client = get_workspace_archive_s3_client()
            assert client is None
