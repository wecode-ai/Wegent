# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MySQL storage backend implementation.

This module provides a MySQL-based storage backend that stores
binary data directly in the database using the SubtaskAttachment model.
This is the default storage backend when no external storage is configured.
"""

import logging
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.models.subtask_attachment import SubtaskAttachment
from app.services.attachment.storage_backend import StorageBackend, StorageError

logger = logging.getLogger(__name__)


class MySQLStorageBackend(StorageBackend):
    """
    MySQL storage backend implementation.

    Stores binary data directly in the SubtaskAttachment.binary_data column.
    This is the default storage backend for backward compatibility.
    """

    BACKEND_TYPE = "mysql"

    def __init__(self, db: Session):
        """
        Initialize MySQL storage backend.

        Args:
            db: SQLAlchemy database session
        """
        self._db = db

    @property
    def backend_type(self) -> str:
        """Get the backend type identifier."""
        return self.BACKEND_TYPE

    def save(self, key: str, data: bytes, metadata: Dict) -> str:
        """
        Save file data to MySQL.

        For MySQL backend, this updates the binary_data column of an existing
        attachment record. The attachment record should already exist with
        the ID extracted from the key.

        Args:
            key: Storage key (format: attachments/{attachment_id})
            data: File binary data
            metadata: Additional metadata (not used for MySQL backend)

        Returns:
            The storage key

        Raises:
            StorageError: If attachment not found or save fails
        """
        try:
            attachment_id = self._extract_attachment_id(key)
            attachment = (
                self._db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                raise StorageError(f"Attachment not found: {attachment_id}", key)

            attachment.binary_data = data
            attachment.storage_backend = self.BACKEND_TYPE
            attachment.storage_key = key
            self._db.flush()

            logger.debug(f"Saved binary data to MySQL for attachment {attachment_id}")
            return key

        except StorageError:
            raise
        except Exception as e:
            logger.error(f"Failed to save to MySQL storage: {e}")
            raise StorageError(f"Failed to save data: {e}", key)

    def get(self, key: str) -> Optional[bytes]:
        """
        Get file data from MySQL.

        Args:
            key: Storage key (format: attachments/{attachment_id})

        Returns:
            File binary data, or None if not found
        """
        try:
            attachment_id = self._extract_attachment_id(key)
            attachment = (
                self._db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                return None

            return attachment.binary_data

        except Exception as e:
            logger.error(f"Failed to get from MySQL storage: {e}")
            return None

    def delete(self, key: str) -> bool:
        """
        Delete file data from MySQL.

        For MySQL backend, this sets binary_data to empty bytes (b'') but doesn't
        delete the attachment record (that's handled by AttachmentService).

        Args:
            key: Storage key (format: attachments/{attachment_id})

        Returns:
            True if deleted successfully, False otherwise
        """
        try:
            attachment_id = self._extract_attachment_id(key)
            attachment = (
                self._db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                return False

            # Set to empty bytes instead of None (NOT NULL constraint)
            attachment.binary_data = b""
            self._db.flush()

            logger.debug(
                f"Deleted binary data from MySQL for attachment {attachment_id}"
            )
            return True

        except Exception as e:
            logger.error(f"Failed to delete from MySQL storage: {e}")
            return False

    def exists(self, key: str) -> bool:
        """
        Check if file exists in MySQL.

        Args:
            key: Storage key (format: attachments/{attachment_id})

        Returns:
            True if file exists and has binary data, False otherwise
        """
        try:
            attachment_id = self._extract_attachment_id(key)
            attachment = (
                self._db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                return False

            # Check if binary_data exists and is not empty
            return (
                attachment.binary_data is not None and len(attachment.binary_data) > 0
            )

        except Exception as e:
            logger.error(f"Failed to check existence in MySQL storage: {e}")
            return False

    def get_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """
        Get URL for file access.

        MySQL backend doesn't support direct URL access.

        Args:
            key: Storage key
            expires: URL expiration time (not used)

        Returns:
            None (MySQL doesn't support direct URL access)
        """
        return None

    def _extract_attachment_id(self, key: str) -> int:
        """
        Extract attachment ID from storage key.

        Args:
            key: Storage key (format: attachments/{uuid}_{timestamp}_{user_id}_{attachment_id})

        Returns:
            Attachment ID

        Raises:
            StorageError: If key format is invalid
        """
        try:
            # Key format: attachments/{uuid}_{timestamp}_{user_id}_{attachment_id}
            parts = key.split("/")
            if len(parts) != 2 or parts[0] != "attachments":
                raise ValueError("Invalid key format")

            # Extract attachment_id from the last part of the key
            # Format: {uuid}_{timestamp}_{user_id}_{attachment_id}
            key_parts = parts[1].split("_")
            if len(key_parts) < 4:
                raise ValueError(
                    "Invalid key format: expected uuid_timestamp_userid_attachmentid"
                )

            # The attachment_id is the last part
            return int(key_parts[-1])
        except (ValueError, IndexError) as e:
            raise StorageError(f"Invalid storage key format: {key}", key)
