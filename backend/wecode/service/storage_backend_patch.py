# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Storage backend registration patch for MinIO/S3 support.

This module registers the MinIO storage backend with the storage backend registry
when imported. It allows the attachment service to use MinIO/S3 for file storage
when configured via environment variables.

Usage:
    Simply import this module to register the MinIO backend:
    
    ```python
    import wecode.service.storage_backend_patch  # noqa: F401
    ```
    
    Then configure the environment variables:
    - ATTACHMENT_STORAGE_BACKEND=minio (or s3)
    - ATTACHMENT_S3_ENDPOINT=http://minio:9000
    - ATTACHMENT_S3_ACCESS_KEY=minioadmin
    - ATTACHMENT_S3_SECRET_KEY=minioadmin
    - ATTACHMENT_S3_BUCKET=attachments
    - ATTACHMENT_S3_REGION=us-east-1
    - ATTACHMENT_S3_USE_SSL=false
"""

import logging

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.attachment import register_storage_backend

logger = logging.getLogger(__name__)


def _create_minio_backend(db: Session):
    """
    Factory function to create a MinIO storage backend instance.

    Args:
        db: SQLAlchemy database session

    Returns:
        MinIOStorageBackend instance
    """
    # Import here to avoid circular imports and allow lazy loading
    from wecode.service.minio_storage import MinIOStorageBackend

    return MinIOStorageBackend(
        db=db,
        endpoint=settings.ATTACHMENT_S3_ENDPOINT,
        access_key=settings.ATTACHMENT_S3_ACCESS_KEY,
        secret_key=settings.ATTACHMENT_S3_SECRET_KEY,
        bucket=settings.ATTACHMENT_S3_BUCKET,
        region=settings.ATTACHMENT_S3_REGION,
        use_ssl=settings.ATTACHMENT_S3_USE_SSL,
    )


def _register_storage_backends():
    """
    Register MinIO and S3 storage backends.

    This function is called automatically when the module is imported.
    It registers both 'minio' and 's3' backend types using the same
    MinIO implementation, as MinIO is S3-compatible.
    """
    try:
        # Register MinIO backend
        register_storage_backend("minio", _create_minio_backend)
        logger.info("Registered MinIO storage backend")

        # Register S3 backend (uses same implementation as MinIO is S3-compatible)
        register_storage_backend("s3", _create_minio_backend)
        logger.info("Registered S3 storage backend")

    except ValueError as e:
        # Backend already registered, this is fine
        logger.debug(f"Storage backend registration skipped: {e}")
    except Exception as e:
        logger.error(f"Failed to register storage backends: {e}")
        raise


# Auto-register backends when module is imported
_register_storage_backends()