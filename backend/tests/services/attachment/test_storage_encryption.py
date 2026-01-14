# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for MySQL storage backend.

Note: Encryption/decryption is now handled at the context_service layer,
not in storage backends. These tests verify that storage backends correctly
store and retrieve raw binary data without modification.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.models.subtask_context import SubtaskContext
from app.services.attachment.mysql_storage import MySQLStorageBackend
from app.services.attachment.storage_backend import StorageError


class TestMySQLStorageBackend:
    """Test cases for MySQL storage backend."""

    def setup_method(self):
        """Set up test fixtures."""
        self.mock_db = MagicMock()
        self.storage = MySQLStorageBackend(self.mock_db)

    def test_save_stores_data_as_is(self):
        """Test that save stores data without modification."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        test_data = b"Test attachment data"
        metadata = {"filename": "test.pdf", "is_encrypted": False}

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.type_data = {"original_filename": "test.pdf"}

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        with patch("app.services.attachment.mysql_storage.flag_modified"):
            result_key = self.storage.save(storage_key, test_data, metadata)

        # Assert
        assert result_key == storage_key
        # Verify binary_data was set exactly as provided (no encryption by storage backend)
        assert mock_context.binary_data == test_data
        # Verify type_data was updated
        assert mock_context.type_data["storage_backend"] == "mysql"
        assert mock_context.type_data["storage_key"] == storage_key

    def test_save_stores_encrypted_data_as_is(self):
        """Test that save stores pre-encrypted data without modification."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        # Simulate pre-encrypted data from context_service layer
        from shared.utils.crypto import encrypt_attachment

        original_data = b"Test attachment data"
        encrypted_data = encrypt_attachment(original_data)
        metadata = {"filename": "test.pdf", "is_encrypted": True}

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.type_data = {"original_filename": "test.pdf"}

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        with patch("app.services.attachment.mysql_storage.flag_modified"):
            result_key = self.storage.save(storage_key, encrypted_data, metadata)

        # Assert
        assert result_key == storage_key
        # Verify storage backend stores the encrypted data as-is
        assert mock_context.binary_data == encrypted_data
        assert mock_context.binary_data != original_data

    def test_get_returns_raw_data(self):
        """Test that get returns raw data without decryption."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        test_data = b"Test attachment data"

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.binary_data = test_data

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result_data = self.storage.get(storage_key)

        # Assert - should return exactly what's stored
        assert result_data == test_data

    def test_get_returns_encrypted_data_as_is(self):
        """Test that get returns encrypted data without decryption (decryption is done at service layer)."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        original_data = b"Test attachment data"

        # Encrypt the data
        from shared.utils.crypto import encrypt_attachment

        encrypted_data = encrypt_attachment(original_data)

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.binary_data = encrypted_data

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result_data = self.storage.get(storage_key)

        # Assert - storage backend returns raw encrypted data (decryption is done at service layer)
        assert result_data == encrypted_data
        assert result_data != original_data

    def test_get_nonexistent_context(self):
        """Test retrieving attachment when context doesn't exist."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_999"
        self.mock_db.query.return_value.filter.return_value.first.return_value = None

        # Act
        result_data = self.storage.get(storage_key)

        # Assert
        assert result_data is None

    def test_save_context_not_found(self):
        """Test saving when context doesn't exist."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_999"
        test_data = b"Test data"
        metadata = {}

        self.mock_db.query.return_value.filter.return_value.first.return_value = None

        # Act & Assert
        with pytest.raises(StorageError) as exc_info:
            self.storage.save(storage_key, test_data, metadata)

        assert "Context not found" in str(exc_info.value)

    def test_delete_sets_empty_bytes(self):
        """Test that delete sets binary_data to empty bytes."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.binary_data = b"Some data"

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result = self.storage.delete(storage_key)

        # Assert
        assert result is True
        assert mock_context.binary_data == b""

    def test_exists_returns_true_when_has_data(self):
        """Test exists returns True when context has binary data."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.binary_data = b"Some data"

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result = self.storage.exists(storage_key)

        # Assert
        assert result is True

    def test_exists_returns_false_when_no_data(self):
        """Test exists returns False when context has no binary data."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.binary_data = b""

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result = self.storage.exists(storage_key)

        # Assert
        assert result is False
