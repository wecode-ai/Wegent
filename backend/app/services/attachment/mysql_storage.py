# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MySQL storage backend implementation.

This module implements the StorageBackend interface using MySQL database
for storing attachment binary data. It reuses the existing SubtaskAttachment
model's binary_data column.
"""

import logging
from typing import Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.models.subtask_attachment import SubtaskAttachment
from app.services.attachment.storage_backend import StorageBackend, StorageError

logger = logging.getLogger(__name__)


class MySQLStorageBackend(StorageBackend):
    """
    MySQL-based storage backend for attachments.

    This backend stores binary data directly in the MySQL database
    using the SubtaskAttachment model's binary_data column.

    Note: This backend is used as the default when no external storage
    is configured, maintaining backward compatibility.
    """

    BACKEND_NAME = "mysql"

    def __init__(self, db_session_factory: Optional[Callable[[], Session]] = None):
        """
        Initialize the MySQL storage backend.

        Args:
            db_session_factory: Optional factory function to create database sessions.
                               If not provided, methods will require a db parameter.
        """
        self._db_session_factory = db_session_factory

    def _get_attachment_id_from_key(self, key: str) -> Optional[int]:
        """
        Extract attachment ID from storage key.

        Args:
            key: Storage key in format 'attachments/{id}'

        Returns:
            Attachment ID or None if key format is invalid
        """
        try:
            if key.startswith("attachments/"):
                return int(key.split("/")[1])
            return int(key)
        except (ValueError, IndexError):
            logger.error(f"Invalid storage key format: {key}")
            return None

    def save(self, key: str, data: bytes, metadata: Dict) -> str:
        """
        Save binary data to MySQL.

        For MySQL backend, the binary data is stored in the SubtaskAttachment
        model's binary_data column. This method updates the existing record
        rather than creating a new one.

        Args:
            key: Storage key in format 'attachments/{id}'
            data: Binary file data
            metadata: Additional metadata (must include 'db' session)

        Returns:
            The storage key

        Raises:
            StorageError: If saving fails
        """
        db = metadata.get("db")
        if db is None:
            raise StorageError("Database session is required for MySQL storage backend")

        attachment_id = self._get_attachment_id_from_key(key)
        if attachment_id is None:
            raise StorageError(f"Invalid storage key: {key}")

        try:
            attachment = (
                db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                raise StorageError(f"Attachment not found: {attachment_id}")

            attachment.binary_data = data
            db.flush()

            logger.debug(f"Binary data saved to MySQL for attachment {attachment_id}")
            return key

        except StorageError:
            raise
        except Exception as e:
            logger.error(f"Failed to save data to MySQL: {e}")
            raise StorageError(f"Failed to save data to MySQL: {e}")

    def get(self, key: str, db: Optional[Session] = None) -> Optional[bytes]:
        """
        Retrieve binary data from MySQL.

        Args:
            key: Storage key in format 'attachments/{id}'
            db: Database session (required)

        Returns:
            Binary file data or None if not found
        """
        if db is None:
            logger.error("Database session is required for MySQL storage backend")
            return None

        attachment_id = self._get_attachment_id_from_key(key)
        if attachment_id is None:
            return None

        try:
            attachment = (
                db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                return None

            return attachment.binary_data

        except Exception as e:
            logger.error(f"Failed to get data from MySQL: {e}")
            return None

    def delete(self, key: str, db: Optional[Session] = None) -> bool:
        """
        Delete binary data from MySQL.

        For MySQL backend, this clears the binary_data column but doesn't
        delete the attachment record (that's handled by AttachmentService).

        Args:
            key: Storage key in format 'attachments/{id}'
            db: Database session (required)

        Returns:
            True if successful, False otherwise
        """
        if db is None:
            logger.error("Database session is required for MySQL storage backend")
            return False

        attachment_id = self._get_attachment_id_from_key(key)
        if attachment_id is None:
            return False

        try:
            attachment = (
                db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment is None:
                return False

            # For MySQL backend, we don't actually clear binary_data here
            # because the entire record will be deleted by AttachmentService
            logger.debug(f"MySQL storage delete called for attachment {attachment_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete data from MySQL: {e}")
            return False

    def exists(self, key: str, db: Optional[Session] = None) -> bool:
        """
        Check if binary data exists in MySQL.

        Args:
            key: Storage key in format 'attachments/{id}'
            db: Database session (required)

        Returns:
            True if data exists, False otherwise
        """
        if db is None:
            logger.error("Database session is required for MySQL storage backend")
            return False

        attachment_id = self._get_attachment_id_from_key(key)
        if attachment_id is None:
            return False

        try:
            attachment = (
                db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            return attachment is not None and attachment.binary_data is not None

        except Exception as e:
            logger.error(f"Failed to check existence in MySQL: {e}")
            return False

    def get_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """
        Get direct access URL for the file.

        MySQL storage doesn't support direct URL access, so this always returns None.
        Files must be accessed through the API endpoint.

        Args:
            key: Storage key
            expires: URL expiration time (ignored)

        Returns:
            None (MySQL doesn't support direct URL access)
        """
        return None
