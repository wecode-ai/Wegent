# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MySQL storage backend implementation.

This module provides a MySQL-based storage backend that stores
binary data directly in the database using the SubtaskContext model.
This is the default storage backend when no external storage is configured.
"""

import logging
from typing import Dict, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.subtask_context import SubtaskContext
from app.services.attachment.storage_backend import StorageBackend, StorageError

logger = logging.getLogger(__name__)


class MySQLStorageBackend(StorageBackend):
    """
    MySQL storage backend implementation.

    Stores binary data directly in the SubtaskContext.binary_data column.
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
        context record. The context record should already exist with
        the ID extracted from the key.

        Note: Encryption is handled at the context_service layer, not here.
        Storage backends are responsible only for raw data storage.

        Args:
            key: Storage key (format: attachments/{context_id})
            data: File binary data (already encrypted if encryption is enabled)
            metadata: Additional metadata including is_encrypted flag

        Returns:
            The storage key

        Raises:
            StorageError: If context not found or save fails
        """
        try:
            context_id = self._extract_attachment_id(key)
            context = (
                self._db.query(SubtaskContext)
                .filter(SubtaskContext.id == context_id)
                .first()
            )

            if context is None:
                raise StorageError(f"Context not found: {context_id}", key)

            context.binary_data = data

            # Update storage_backend and storage_key in type_data
            if context.type_data and isinstance(context.type_data, dict):
                context.type_data = {
                    **context.type_data,
                    "storage_backend": self.BACKEND_TYPE,
                    "storage_key": key,
                }
                # Mark JSON field as modified so SQLAlchemy detects the change
                flag_modified(context, "type_data")
            self._db.flush()

            logger.debug(f"Saved binary data to MySQL for context {context_id}")
            return key

        except StorageError:
            raise
        except Exception as e:
            logger.error(f"Failed to save to MySQL storage: {e}")
            raise StorageError(f"Failed to save data: {e}", key)

    def get(self, key: str) -> Optional[bytes]:
        """
        Get file data from MySQL.

        Note: Decryption is handled at the context_service layer, not here.
        This method returns raw binary data as stored in the database.

        Args:
            key: Storage key (format: attachments/{context_id})

        Returns:
            File binary data (raw, may be encrypted), or None if not found
        """
        try:
            context_id = self._extract_attachment_id(key)
            context = (
                self._db.query(SubtaskContext)
                .filter(SubtaskContext.id == context_id)
                .first()
            )

            if context is None:
                return None

            return context.binary_data

        except Exception as e:
            logger.error(f"Failed to get from MySQL storage: {e}")
            return None

    def delete(self, key: str) -> bool:
        """
        Delete file data from MySQL.

        For MySQL backend, this sets binary_data to empty bytes (b'') but doesn't
        delete the context record (that's handled by ContextService).

        Args:
            key: Storage key (format: attachments/{context_id})

        Returns:
            True if deleted successfully, False otherwise
        """
        try:
            context_id = self._extract_attachment_id(key)
            context = (
                self._db.query(SubtaskContext)
                .filter(SubtaskContext.id == context_id)
                .first()
            )

            if context is None:
                return False

            # Set to empty bytes instead of None (NOT NULL constraint)
            context.binary_data = b""
            self._db.flush()

            logger.debug(f"Deleted binary data from MySQL for context {context_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete from MySQL storage: {e}")
            return False

    def exists(self, key: str) -> bool:
        """
        Check if file exists in MySQL.

        Args:
            key: Storage key (format: attachments/{context_id})

        Returns:
            True if file exists and has binary data, False otherwise
        """
        try:
            context_id = self._extract_attachment_id(key)
            context = (
                self._db.query(SubtaskContext)
                .filter(SubtaskContext.id == context_id)
                .first()
            )

            if context is None:
                return False

            # Check if binary_data exists and is not empty
            return context.binary_data is not None and len(context.binary_data) > 0

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
        Extract context ID from storage key.

        Args:
            key: Storage key (format: attachments/{uuid}_{timestamp}_{user_id}_{context_id})

        Returns:
            Context ID

        Raises:
            StorageError: If key format is invalid
        """
        try:
            # Key format: attachments/{uuid}_{timestamp}_{user_id}_{context_id}
            parts = key.split("/")
            if len(parts) != 2 or parts[0] != "attachments":
                raise ValueError("Invalid key format")

            # Extract context_id from the last part of the key
            # Format: {uuid}_{timestamp}_{user_id}_{context_id}
            key_parts = parts[1].split("_")
            if len(key_parts) < 4:
                raise ValueError(
                    "Invalid key format: expected uuid_timestamp_userid_contextid"
                )

            # The context_id is the last part
            return int(key_parts[-1])
        except (ValueError, IndexError) as e:
            raise StorageError(f"Invalid storage key format: {key}", key)
