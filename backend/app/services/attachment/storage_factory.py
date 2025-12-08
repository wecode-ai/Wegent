# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend factory for creating storage backend instances.

This module provides a factory function to create the appropriate
storage backend based on configuration.
"""

import logging
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.attachment.mysql_storage import MySQLStorageBackend
from app.services.attachment.storage_backend import StorageBackend

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


def get_storage_backend(db: Session) -> StorageBackend:
    """
    Get the configured storage backend instance.

    Creates and returns the appropriate storage backend based on
    the ATTACHMENT_STORAGE_BACKEND configuration setting.

    Args:
        db: SQLAlchemy database session (required for MySQL backend)

    Returns:
        StorageBackend instance

    Raises:
        ValueError: If configured backend is not supported
    """
    backend_type = settings.ATTACHMENT_STORAGE_BACKEND.lower()

    if backend_type == "mysql":
        logger.debug("Using MySQL storage backend")
        return MySQLStorageBackend(db)

    elif backend_type in ("s3", "minio"):
        # S3/MinIO backend would be implemented here
        # For now, fall back to MySQL with a warning
        logger.warning(
            f"Storage backend '{backend_type}' is not yet implemented. "
            f"Falling back to MySQL storage backend."
        )
        return MySQLStorageBackend(db)

    else:
        raise ValueError(
            f"Unsupported storage backend: {backend_type}. "
            f"Supported backends: mysql, s3, minio"
        )


def is_external_storage_configured() -> bool:
    """
    Check if an external storage backend is configured.

    Returns:
        True if external storage (S3/MinIO) is configured, False otherwise
    """
    backend_type = settings.ATTACHMENT_STORAGE_BACKEND.lower()
    return backend_type in ("s3", "minio")
