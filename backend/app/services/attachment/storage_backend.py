# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract storage backend interface for attachment storage.

This module defines the abstract base class for storage backends.
Different storage implementations (MySQL, S3, MinIO, etc.) should implement this interface.

To implement a custom storage backend:
1. Create a new class that inherits from StorageBackend
2. Implement all abstract methods (save, get, delete, exists)
3. Optionally override get_url if the backend supports direct URL access
4. Register the backend in storage_factory.py or configure via ATTACHMENT_STORAGE_BACKEND
"""

from abc import ABC, abstractmethod
from typing import Dict, Optional


class StorageBackend(ABC):
    """
    Abstract base class for attachment storage backends.

    All storage backend implementations must inherit from this class and
    implement the required abstract methods.
    """

    @abstractmethod
    def save(self, key: str, data: bytes, metadata: Dict) -> str:
        """
        Save file data to the storage backend.

        Args:
            key: Unique identifier for the file (format: attachments/{attachment_id})
            data: Binary file data to store
            metadata: Additional metadata (filename, mime_type, file_size, etc.)

        Returns:
            The storage key after saving (may be modified by the backend)

        Raises:
            StorageError: If saving fails
        """
        pass

    @abstractmethod
    def get(self, key: str) -> Optional[bytes]:
        """
        Retrieve file data from the storage backend.

        Args:
            key: Unique identifier for the file

        Returns:
            Binary file data if found, None otherwise
        """
        pass

    @abstractmethod
    def delete(self, key: str) -> bool:
        """
        Delete a file from the storage backend.

        Args:
            key: Unique identifier for the file

        Returns:
            True if deletion was successful, False otherwise
        """
        pass

    @abstractmethod
    def exists(self, key: str) -> bool:
        """
        Check if a file exists in the storage backend.

        Args:
            key: Unique identifier for the file

        Returns:
            True if the file exists, False otherwise
        """
        pass

    def get_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """
        Get a direct access URL for the file.

        This is an optional method that storage backends can implement
        if they support direct URL access (e.g., S3 presigned URLs).

        Args:
            key: Unique identifier for the file
            expires: URL expiration time in seconds (default: 1 hour)

        Returns:
            Direct access URL if supported, None otherwise
        """
        return None


class StorageError(Exception):
    """Exception raised when storage operations fail."""

    pass
