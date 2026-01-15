# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for attachment encryption functionality.
"""

import os
from unittest.mock import MagicMock, patch

import pytest
from shared.utils.crypto import (
    decrypt_attachment,
    encrypt_attachment,
    is_attachment_encrypted,
)


class TestAttachmentEncryption:
    """Test cases for attachment encryption/decryption functions."""

    def test_encrypt_decrypt_roundtrip(self):
        """Test that encryption and decryption work correctly together."""
        # Arrange
        original_data = b"This is test attachment data with some content."

        # Act
        encrypted_data = encrypt_attachment(original_data)
        decrypted_data = decrypt_attachment(encrypted_data)

        # Assert
        assert decrypted_data == original_data
        assert encrypted_data != original_data
        assert len(encrypted_data) % 16 == 0  # Should be padded to AES block size

    def test_encrypt_empty_data(self):
        """Test encrypting empty data."""
        # Arrange
        original_data = b""

        # Act
        encrypted_data = encrypt_attachment(original_data)

        # Assert
        assert encrypted_data == b""

    def test_decrypt_empty_data(self):
        """Test decrypting empty data."""
        # Arrange
        encrypted_data = b""

        # Act
        decrypted_data = decrypt_attachment(encrypted_data)

        # Assert
        assert decrypted_data == b""

    def test_encrypt_large_data(self):
        """Test encrypting large data (simulates large attachment)."""
        # Arrange - Create 10MB of data
        original_data = b"x" * (10 * 1024 * 1024)

        # Act
        encrypted_data = encrypt_attachment(original_data)
        decrypted_data = decrypt_attachment(encrypted_data)

        # Assert
        assert decrypted_data == original_data
        assert len(encrypted_data) % 16 == 0

    def test_is_attachment_encrypted_with_encrypted_data(self):
        """Test detecting encrypted data."""
        # Arrange
        original_data = b"Test data"
        encrypted_data = encrypt_attachment(original_data)

        # Act
        result = is_attachment_encrypted(encrypted_data)

        # Assert
        assert result is True

    def test_is_attachment_encrypted_with_plain_data(self):
        """Test detecting plain text data."""
        # Arrange - Plain data that is not a multiple of 16
        plain_data = b"This is plain text data"

        # Act
        result = is_attachment_encrypted(plain_data)

        # Assert
        assert result is False

    def test_is_attachment_encrypted_with_empty_data(self):
        """Test detecting empty data."""
        # Arrange
        empty_data = b""

        # Act
        result = is_attachment_encrypted(empty_data)

        # Assert
        assert result is False

    def test_decrypt_with_wrong_key_should_fail(self):
        """Test that decryption with wrong key fails."""
        # Arrange
        original_data = b"Secret data"
        encrypted_data = encrypt_attachment(original_data)

        # Act - Change the encryption key temporarily
        with patch.dict(
            os.environ, {"ATTACHMENT_AES_KEY": "00000000000000000000000000000000"}
        ):
            # Force key reload by clearing cache
            from shared.utils import crypto

            crypto._attachment_aes_key = None
            crypto._attachment_aes_iv = None

            # Assert - Should raise exception
            with pytest.raises(Exception):
                decrypt_attachment(encrypted_data)

    def test_encrypt_with_custom_keys(self):
        """Test encryption with custom keys from environment variables."""
        # Arrange
        original_data = b"Test data with custom keys"
        custom_key = "abcdefghijklmnopqrstuvwxyz012345"
        custom_iv = "0123456789abcdef"

        # Act
        with patch.dict(
            os.environ,
            {"ATTACHMENT_AES_KEY": custom_key, "ATTACHMENT_AES_IV": custom_iv},
        ):
            # Force key reload
            from shared.utils import crypto

            crypto._attachment_aes_key = None
            crypto._attachment_aes_iv = None

            encrypted_data = encrypt_attachment(original_data)
            decrypted_data = decrypt_attachment(encrypted_data)

        # Assert
        assert decrypted_data == original_data
        assert encrypted_data != original_data

    def test_encrypt_binary_data(self):
        """Test encrypting binary data (not just text)."""
        # Arrange - Create binary data with various byte values
        original_data = bytes(range(256))

        # Act
        encrypted_data = encrypt_attachment(original_data)
        decrypted_data = decrypt_attachment(encrypted_data)

        # Assert
        assert decrypted_data == original_data
        assert encrypted_data != original_data

    def test_encrypt_unicode_data(self):
        """Test encrypting unicode text data."""
        # Arrange
        original_text = "测试中文加密 Test Unicode 日本語 🔐"
        original_data = original_text.encode("utf-8")

        # Act
        encrypted_data = encrypt_attachment(original_data)
        decrypted_data = decrypt_attachment(encrypted_data)

        # Assert
        assert decrypted_data == original_data
        assert decrypted_data.decode("utf-8") == original_text
