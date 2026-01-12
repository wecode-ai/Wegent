# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend abstract interface for attachment storage.

This module defines the abstract base class for storage backends,
allowing pluggable storage solutions (MySQL, S3, MinIO, etc.).

ENCRYPTION SUPPORT:
Storage backends can optionally encrypt attachment binary data using AES-256-CBC.
Encryption is controlled by the ATTACHMENT_ENCRYPTION_ENABLED environment variable.
When enabled, backends should:
1. Encrypt binary data before saving using _encrypt_if_enabled()
2. Decrypt binary data when retrieving using _decrypt_if_needed()
3. Store encryption metadata in the context's type_data field

Encryption is transparent to API consumers - they always receive decrypted data.
"""

import logging
import os
import uuid
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class StorageBackend(ABC):
    """
    Abstract base class for attachment storage backends.

    Different storage backends (MySQL, S3, MinIO, etc.) should implement this interface.
    This allows the attachment service to use any storage backend without changes.

    ENCRYPTION SUPPORT:
    Subclasses can use the helper methods _should_encrypt(), _encrypt_if_enabled(),
    and _decrypt_if_needed() to implement transparent encryption/decryption.
    """

    @staticmethod
    def _should_encrypt() -> bool:
        """
        Check if attachment encryption is enabled.

        Returns:
            True if ATTACHMENT_ENCRYPTION_ENABLED is set to true, False otherwise
        """
        return (
            os.environ.get("ATTACHMENT_ENCRYPTION_ENABLED", "false").lower() == "true"
        )

    @staticmethod
    def _encrypt_if_enabled(data: bytes) -> bytes:
        """
        Conditionally encrypt data if encryption is enabled.

        Args:
            data: Binary data to encrypt

        Returns:
            Encrypted data if encryption is enabled, otherwise original data

        Raises:
            Exception: If encryption is enabled but fails
        """
        if not StorageBackend._should_encrypt():
            return data

        # Import here to avoid circular dependency
        from shared.utils.crypto import encrypt_attachment

        logger.info("Encrypting attachment data with AES-256-CBC")
        return encrypt_attachment(data)

    @staticmethod
    def _decrypt_if_needed(data: bytes, is_encrypted: bool) -> bytes:
        """
        Conditionally decrypt data if it's marked as encrypted.

        Args:
            data: Binary data to decrypt
            is_encrypted: Whether the data is encrypted (from type_data)

        Returns:
            Decrypted data if encrypted, otherwise original data

        Raises:
            Exception: If decryption fails
        """
        if not is_encrypted:
            return data

        # Import here to avoid circular dependency
        from shared.utils.crypto import decrypt_attachment

        logger.debug("Decrypting attachment data")
        return decrypt_attachment(data)

    @abstractmethod
    def save(self, key: str, data: bytes, metadata: Dict) -> str:
        """
        Save file data to the storage backend.

        Args:
            key: Unique storage key (format: attachments/{attachment_id})
            data: File binary data
            metadata: Additional metadata (filename, mime_type, etc.)

        Returns:
            The storage key after saving (may be modified by the backend)

        Raises:
            StorageError: If save operation fails
        """

    @abstractmethod
    def get(self, key: str) -> Optional[bytes]:
        """
        Get file data from the storage backend.

        Args:
            key: Storage key to retrieve

        Returns:
            File binary data, or None if not found
        """

    @abstractmethod
    def delete(self, key: str) -> bool:
        """
        Delete file from the storage backend.

        Args:
            key: Storage key to delete

        Returns:
            True if deleted successfully, False otherwise
        """

    @abstractmethod
    def exists(self, key: str) -> bool:
        """
        Check if file exists in the storage backend.

        Args:
            key: Storage key to check

        Returns:
            True if file exists, False otherwise
        """

    def get_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """
        Get a URL for accessing the file.

        This is optional - backends that don't support direct URL access
        should return None.

        Args:
            key: Storage key
            expires: URL expiration time in seconds (default: 3600)

        Returns:
            URL string if supported, None otherwise
        """
        return None

    @property
    @abstractmethod
    def backend_type(self) -> str:
        """
        Get the backend type identifier.

        Returns:
            Backend type string (e.g., "mysql", "s3", "minio")
        """


class StorageError(Exception):
    """Exception raised when storage operations fail."""

    def __init__(self, message: str, key: Optional[str] = None):
        self.message = message
        self.key = key
        super().__init__(self.message)


def generate_storage_key(attachment_id: int, user_id: int) -> str:
    """
    Generate a unique storage key for an attachment.

    The key format is: attachments/{uuid}_{timestamp}_{user_id}_{attachment_id}
    This provides:
    - UUID: Ensures global uniqueness and prevents key collision
    - Timestamp: Enables time-based organization and debugging
    - User ID: Allows user-based partitioning and access control
    - Attachment ID: Maintains reference to database record

    Args:
        attachment_id: The attachment ID from database
        user_id: The user ID who owns the attachment

    Returns:
        Storage key in format: attachments/{uuid}_{timestamp}_{user_id}_{attachment_id}
    """
    unique_id = uuid.uuid4().hex[:12]  # Use first 12 chars of UUID for brevity
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    return f"attachments/{unique_id}_{timestamp}_{user_id}_{attachment_id}"
