# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for MySQL storage backend encryption functionality.
"""

import os
from unittest.mock import MagicMock, patch

import pytest

from app.models.subtask_context import SubtaskContext
from app.services.attachment.mysql_storage import MySQLStorageBackend
from app.services.attachment.storage_backend import StorageError


class TestMySQLStorageEncryption:
    """Test cases for MySQL storage backend encryption."""

    def setup_method(self):
        """Set up test fixtures."""
        self.mock_db = MagicMock()
        self.storage = MySQLStorageBackend(self.mock_db)

    def test_save_with_encryption_enabled(self):
        """Test saving attachment with encryption enabled."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        test_data = b"Test attachment data"
        metadata = {"filename": "test.pdf"}

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.type_data = {"original_filename": "test.pdf"}

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        with patch.dict(os.environ, {"ATTACHMENT_ENCRYPTION_ENABLED": "true"}):
            with patch("app.services.attachment.mysql_storage.flag_modified"):
                result_key = self.storage.save(storage_key, test_data, metadata)

        # Assert
        assert result_key == storage_key
        # Verify binary_data was set (should be encrypted, different from original)
        assert mock_context.binary_data != test_data
        assert len(mock_context.binary_data) % 16 == 0  # Should be AES block aligned
        # Verify type_data was updated with encryption metadata
        assert mock_context.type_data["is_encrypted"] is True
        assert mock_context.type_data["encryption_version"] == 1
        assert mock_context.type_data["storage_backend"] == "mysql"
        assert mock_context.type_data["storage_key"] == storage_key

    def test_save_without_encryption(self):
        """Test saving attachment without encryption."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        test_data = b"Test attachment data"
        metadata = {"filename": "test.pdf"}

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.type_data = {"original_filename": "test.pdf"}

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        with patch.dict(os.environ, {"ATTACHMENT_ENCRYPTION_ENABLED": "false"}):
            with patch("app.services.attachment.mysql_storage.flag_modified"):
                result_key = self.storage.save(storage_key, test_data, metadata)

        # Assert
        assert result_key == storage_key
        # Verify binary_data was set (should be plain, same as original)
        assert mock_context.binary_data == test_data
        # Verify type_data was updated without encryption metadata
        assert mock_context.type_data["is_encrypted"] is False
        assert mock_context.type_data["encryption_version"] == 0

    def test_get_with_encrypted_data(self):
        """Test retrieving and automatically decrypting encrypted attachment."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        original_data = b"Test attachment data"

        # Encrypt the test data first
        with patch.dict(os.environ, {"ATTACHMENT_ENCRYPTION_ENABLED": "true"}):
            from shared.utils.crypto import encrypt_attachment

            encrypted_data = encrypt_attachment(original_data)

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.binary_data = encrypted_data
        mock_context.type_data = {"is_encrypted": True, "encryption_version": 1}

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result_data = self.storage.get(storage_key)

        # Assert
        assert result_data == original_data
        assert result_data != encrypted_data

    def test_get_with_plain_data(self):
        """Test retrieving plain (unencrypted) attachment."""
        # Arrange
        storage_key = "attachments/test123_20250113_1_100"
        original_data = b"Test attachment data"

        mock_context = MagicMock(spec=SubtaskContext)
        mock_context.id = 100
        mock_context.binary_data = original_data
        mock_context.type_data = {"is_encrypted": False}

        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_context
        )

        # Act
        result_data = self.storage.get(storage_key)

        # Assert
        assert result_data == original_data

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

    def test_mixed_encrypted_and_plain_attachments(self):
        """Test handling both encrypted and plain attachments in same database."""
        # Arrange
        plain_key = "attachments/plain_20250113_1_100"
        encrypted_key = "attachments/encrypted_20250113_1_101"
        test_data = b"Test data"

        # Set up plain attachment
        plain_context = MagicMock(spec=SubtaskContext)
        plain_context.id = 100
        plain_context.binary_data = test_data
        plain_context.type_data = {"is_encrypted": False}

        # Set up encrypted attachment
        with patch.dict(os.environ, {"ATTACHMENT_ENCRYPTION_ENABLED": "true"}):
            from shared.utils.crypto import encrypt_attachment

            encrypted_data = encrypt_attachment(test_data)

        encrypted_context = MagicMock(spec=SubtaskContext)
        encrypted_context.id = 101
        encrypted_context.binary_data = encrypted_data
        encrypted_context.type_data = {"is_encrypted": True, "encryption_version": 1}

        # Act - Retrieve plain attachment
        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            plain_context
        )
        plain_result = self.storage.get(plain_key)

        # Act - Retrieve encrypted attachment
        self.mock_db.query.return_value.filter.return_value.first.return_value = (
            encrypted_context
        )
        encrypted_result = self.storage.get(encrypted_key)

        # Assert - Both should return the same original data
        assert plain_result == test_data
        assert encrypted_result == test_data
