# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for MinIO storage backend.

These tests use mocking to avoid requiring an actual MinIO server.
"""

from io import BytesIO
from unittest.mock import MagicMock, PropertyMock, patch

import pytest
from minio.error import S3Error


class TestMinIOStorageBackend:
    """Tests for MinIOStorageBackend class."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        db = MagicMock()
        return db

    @pytest.fixture
    def mock_minio_client(self):
        """Create a mock MinIO client."""
        with patch("wecode.service.minio_storage.Minio") as mock_minio:
            client = MagicMock()
            mock_minio.return_value = client
            client.bucket_exists.return_value = True
            yield client

    @pytest.fixture
    def storage_backend(self, mock_db, mock_minio_client):
        """Create a MinIOStorageBackend instance with mocked dependencies."""
        from wecode.service.minio_storage import MinIOStorageBackend

        with patch.object(MinIOStorageBackend, "_ensure_bucket_exists"):
            backend = MinIOStorageBackend(
                db=mock_db,
                endpoint="http://localhost:9000",
                access_key="minioadmin",
                secret_key="minioadmin",
                bucket="test-bucket",
                region="us-east-1",
                use_ssl=False,
            )
            backend._client = mock_minio_client
            return backend

    def test_backend_type(self, storage_backend):
        """Test that backend_type returns 'minio'."""
        assert storage_backend.backend_type == "minio"

    def test_save_success(self, storage_backend, mock_db):
        """Test successful file save to MinIO."""
        # Setup
        key = "attachments/abc123_20231201120000_1_100"
        data = b"test file content"
        metadata = {
            "filename": "test.txt",
            "mime_type": "text/plain",
            "file_size": len(data),
            "user_id": 1,
        }

        # Mock attachment query
        mock_attachment = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_attachment
        )

        # Execute
        result = storage_backend.save(key, data, metadata)

        # Verify
        assert result == key
        storage_backend._client.put_object.assert_called_once()
        call_args = storage_backend._client.put_object.call_args
        assert call_args[0][0] == "test-bucket"  # bucket
        assert call_args[0][1] == key  # object name
        assert call_args[1]["content_type"] == "text/plain"

    def test_save_updates_attachment_record(self, storage_backend, mock_db):
        """Test that save updates the attachment record in database."""
        key = "attachments/abc123_20231201120000_1_100"
        data = b"test content"
        metadata = {"filename": "test.txt", "mime_type": "text/plain"}

        mock_attachment = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_attachment
        )

        storage_backend.save(key, data, metadata)

        # Verify attachment record was updated
        assert mock_attachment.binary_data == b""
        assert mock_attachment.storage_backend == "minio"
        assert mock_attachment.storage_key == key
        mock_db.flush.assert_called_once()

    def test_save_s3_error(self, storage_backend, mock_db):
        """Test save handles S3Error properly."""
        from app.services.attachment.storage_backend import StorageError

        key = "attachments/abc123_20231201120000_1_100"
        data = b"test content"
        metadata = {"filename": "test.txt", "mime_type": "text/plain"}

        # Mock S3 error
        storage_backend._client.put_object.side_effect = S3Error(
            code="InternalError",
            message="Internal server error",
            resource="test-bucket",
            request_id="123",
            host_id="456",
            response=MagicMock(),
        )

        with pytest.raises(StorageError) as exc_info:
            storage_backend.save(key, data, metadata)

        assert "Failed to save data to MinIO" in str(exc_info.value)

    def test_get_success(self, storage_backend):
        """Test successful file retrieval from MinIO."""
        key = "attachments/abc123_20231201120000_1_100"
        expected_data = b"test file content"

        # Mock response
        mock_response = MagicMock()
        mock_response.read.return_value = expected_data
        storage_backend._client.get_object.return_value = mock_response

        result = storage_backend.get(key)

        assert result == expected_data
        storage_backend._client.get_object.assert_called_once_with("test-bucket", key)
        mock_response.close.assert_called_once()
        mock_response.release_conn.assert_called_once()

    def test_get_not_found(self, storage_backend):
        """Test get returns None when object doesn't exist."""
        key = "attachments/nonexistent"

        storage_backend._client.get_object.side_effect = S3Error(
            code="NoSuchKey",
            message="Object not found",
            resource="test-bucket",
            request_id="123",
            host_id="456",
            response=MagicMock(),
        )

        result = storage_backend.get(key)

        assert result is None

    def test_delete_success(self, storage_backend):
        """Test successful file deletion from MinIO."""
        key = "attachments/abc123_20231201120000_1_100"

        result = storage_backend.delete(key)

        assert result is True
        storage_backend._client.remove_object.assert_called_once_with(
            "test-bucket", key
        )

    def test_delete_not_found_returns_true(self, storage_backend):
        """Test delete returns True when object doesn't exist (idempotent)."""
        key = "attachments/nonexistent"

        storage_backend._client.remove_object.side_effect = S3Error(
            code="NoSuchKey",
            message="Object not found",
            resource="test-bucket",
            request_id="123",
            host_id="456",
            response=MagicMock(),
        )

        result = storage_backend.delete(key)

        assert result is True  # Idempotent - already deleted

    def test_delete_error(self, storage_backend):
        """Test delete returns False on other errors."""
        key = "attachments/abc123_20231201120000_1_100"

        storage_backend._client.remove_object.side_effect = S3Error(
            code="AccessDenied",
            message="Access denied",
            resource="test-bucket",
            request_id="123",
            host_id="456",
            response=MagicMock(),
        )

        result = storage_backend.delete(key)

        assert result is False

    def test_exists_true(self, storage_backend):
        """Test exists returns True when object exists."""
        key = "attachments/abc123_20231201120000_1_100"

        storage_backend._client.stat_object.return_value = MagicMock()

        result = storage_backend.exists(key)

        assert result is True
        storage_backend._client.stat_object.assert_called_once_with("test-bucket", key)

    def test_exists_false(self, storage_backend):
        """Test exists returns False when object doesn't exist."""
        key = "attachments/nonexistent"

        storage_backend._client.stat_object.side_effect = S3Error(
            code="NoSuchKey",
            message="Object not found",
            resource="test-bucket",
            request_id="123",
            host_id="456",
            response=MagicMock(),
        )

        result = storage_backend.exists(key)

        assert result is False

    def test_get_url_success(self, storage_backend):
        """Test successful presigned URL generation."""
        key = "attachments/abc123_20231201120000_1_100"
        expected_url = "https://minio:9000/test-bucket/attachments/abc123?signature=xxx"

        storage_backend._client.presigned_get_object.return_value = expected_url

        result = storage_backend.get_url(key, expires=3600)

        assert result == expected_url
        storage_backend._client.presigned_get_object.assert_called_once()

    def test_get_url_error(self, storage_backend):
        """Test get_url returns None on error."""
        key = "attachments/abc123_20231201120000_1_100"

        storage_backend._client.presigned_get_object.side_effect = S3Error(
            code="InternalError",
            message="Internal error",
            resource="test-bucket",
            request_id="123",
            host_id="456",
            response=MagicMock(),
        )

        result = storage_backend.get_url(key)

        assert result is None

    def test_extract_attachment_id_valid(self, storage_backend):
        """Test extracting attachment ID from valid key."""
        key = "attachments/abc123def456_20231201120000_1_100"

        result = storage_backend._extract_attachment_id(key)

        assert result == 100

    def test_extract_attachment_id_invalid_format(self, storage_backend):
        """Test extracting attachment ID from invalid key raises error."""
        from app.services.attachment.storage_backend import StorageError

        invalid_keys = [
            "invalid/key",
            "attachments/invalid",
            "wrong_prefix/abc_123_456_789",
            "",
        ]

        for key in invalid_keys:
            with pytest.raises(StorageError):
                storage_backend._extract_attachment_id(key)

    def test_encode_metadata_value_ascii(self, storage_backend):
        """Test that ASCII filenames are not modified."""
        result = storage_backend._encode_metadata_value("test.txt")
        assert result == "test.txt"

    def test_encode_metadata_value_chinese(self, storage_backend):
        """Test that Chinese filenames are URL-encoded."""
        result = storage_backend._encode_metadata_value("需求进度汇总.xlsx")
        # Chinese characters should be URL-encoded
        assert "需求" not in result
        assert "%E9%9C%80%E6%B1%82" in result  # URL-encoded "需求"

    def test_encode_metadata_value_mixed(self, storage_backend):
        """Test that mixed ASCII and non-ASCII filenames are properly encoded."""
        result = storage_backend._encode_metadata_value("report_报告_2024.pdf")
        # ASCII parts should remain, Chinese should be encoded
        assert "report_" in result
        assert "_2024.pdf" in result
        assert "报告" not in result

    def test_encode_metadata_value_empty(self, storage_backend):
        """Test that empty string returns empty string."""
        result = storage_backend._encode_metadata_value("")
        assert result == ""

    def test_encode_metadata_value_none(self, storage_backend):
        """Test that None-like values return empty string."""
        result = storage_backend._encode_metadata_value(None)
        assert result == ""

    def test_save_with_chinese_filename(self, storage_backend, mock_db):
        """Test saving file with Chinese filename encodes metadata properly."""
        key = "attachments/abc123_20231201120000_1_100"
        data = b"test content"
        metadata = {
            "filename": "需求进度汇总.xlsx",
            "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "user_id": 1,
        }

        mock_attachment = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_attachment
        )

        # Should not raise an error
        result = storage_backend.save(key, data, metadata)

        assert result == key
        # Verify put_object was called with encoded filename in metadata
        call_kwargs = storage_backend._client.put_object.call_args[1]
        encoded_filename = call_kwargs["metadata"]["filename"]
        # The filename should be URL-encoded (no Chinese characters)
        assert "需求" not in encoded_filename


class TestStorageBackendRegistration:
    """Tests for storage backend registration."""

    def test_minio_backend_registered(self):
        """Test that MinIO backend is registered after importing patch module."""
        # Import the patch module to trigger registration
        import wecode.service.storage_backend_patch  # noqa: F401
        from app.services.attachment import is_storage_backend_registered

        assert is_storage_backend_registered("minio") is True

    def test_s3_backend_registered(self):
        """Test that S3 backend is registered after importing patch module."""
        # Import the patch module to trigger registration
        import wecode.service.storage_backend_patch  # noqa: F401
        from app.services.attachment import is_storage_backend_registered

        assert is_storage_backend_registered("s3") is True

    def test_list_backends_includes_minio(self):
        """Test that list_storage_backends includes minio and s3."""
        # Import the patch module to trigger registration
        import wecode.service.storage_backend_patch  # noqa: F401
        from app.services.attachment import list_storage_backends

        backends = list_storage_backends()

        assert "mysql" in backends  # Default backend
        assert "minio" in backends
        assert "s3" in backends


class TestMinIOEndpointParsing:
    """Tests for MinIO endpoint URL parsing."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    def test_http_endpoint_disables_ssl(self, mock_db):
        """Test that http:// endpoint disables SSL."""
        with patch("wecode.service.minio_storage.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_minio.return_value = mock_client
            mock_client.bucket_exists.return_value = True

            from wecode.service.minio_storage import MinIOStorageBackend

            MinIOStorageBackend(
                db=mock_db,
                endpoint="http://minio:9000",
                access_key="test",
                secret_key="test",
                bucket="test",
            )

            # Verify Minio was called with secure=False
            mock_minio.assert_called_once()
            call_kwargs = mock_minio.call_args[1]
            assert call_kwargs["secure"] is False

    def test_https_endpoint_enables_ssl(self, mock_db):
        """Test that https:// endpoint enables SSL."""
        with patch("wecode.service.minio_storage.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_minio.return_value = mock_client
            mock_client.bucket_exists.return_value = True

            from wecode.service.minio_storage import MinIOStorageBackend

            MinIOStorageBackend(
                db=mock_db,
                endpoint="https://s3.amazonaws.com",
                access_key="test",
                secret_key="test",
                bucket="test",
            )

            # Verify Minio was called with secure=True
            mock_minio.assert_called_once()
            call_kwargs = mock_minio.call_args[1]
            assert call_kwargs["secure"] is True

    def test_endpoint_without_protocol(self, mock_db):
        """Test endpoint without protocol uses use_ssl parameter."""
        with patch("wecode.service.minio_storage.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_minio.return_value = mock_client
            mock_client.bucket_exists.return_value = True

            from wecode.service.minio_storage import MinIOStorageBackend

            MinIOStorageBackend(
                db=mock_db,
                endpoint="minio:9000",
                access_key="test",
                secret_key="test",
                bucket="test",
                use_ssl=False,
            )

            # Verify Minio was called with the endpoint as-is
            mock_minio.assert_called_once()
            call_args = mock_minio.call_args[0]
            assert call_args[0] == "minio:9000"


class TestBucketCreation:
    """Tests for automatic bucket creation."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    def test_creates_bucket_if_not_exists(self, mock_db):
        """Test that bucket is created if it doesn't exist."""
        with patch("wecode.service.minio_storage.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_minio.return_value = mock_client
            mock_client.bucket_exists.return_value = False

            from wecode.service.minio_storage import MinIOStorageBackend

            MinIOStorageBackend(
                db=mock_db,
                endpoint="http://minio:9000",
                access_key="test",
                secret_key="test",
                bucket="new-bucket",
                region="us-west-2",
            )

            mock_client.bucket_exists.assert_called_once_with("new-bucket")
            mock_client.make_bucket.assert_called_once_with(
                "new-bucket", location="us-west-2"
            )

    def test_skips_bucket_creation_if_exists(self, mock_db):
        """Test that bucket creation is skipped if bucket exists."""
        with patch("wecode.service.minio_storage.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_minio.return_value = mock_client
            mock_client.bucket_exists.return_value = True

            from wecode.service.minio_storage import MinIOStorageBackend

            MinIOStorageBackend(
                db=mock_db,
                endpoint="http://minio:9000",
                access_key="test",
                secret_key="test",
                bucket="existing-bucket",
            )

            mock_client.bucket_exists.assert_called_once_with("existing-bucket")
            mock_client.make_bucket.assert_not_called()
