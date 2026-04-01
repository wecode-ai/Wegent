# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MinIO storage service for workspace archives.

Provides presigned URL generation for direct upload/download between
executor and MinIO, avoiding large file transfers through backend.
"""

import logging
import os
from datetime import datetime, timedelta
from typing import Optional

from minio import Minio
from minio.error import S3Error

from app.core.config import settings

logger = logging.getLogger(__name__)


# Archive configuration constants
ARCHIVE_MAX_SIZE_MB = int(os.getenv("ARCHIVE_MAX_SIZE_MB", "500"))
ARCHIVE_RETENTION_DAYS = int(os.getenv("ARCHIVE_RETENTION_DAYS", "30"))
ARCHIVE_BUCKET = os.getenv("ARCHIVE_BUCKET", "wegent-archives")
ARCHIVE_ENABLED = os.getenv("ARCHIVE_ENABLED", "true").lower() == "true"


class ArchiveStorageService:
    """MinIO storage service for workspace archives.

    Uses presigned URLs for direct executor-to-MinIO transfers:
    - Upload: Executor packages workspace and uploads directly to MinIO
    - Download: Executor downloads archive directly from MinIO

    This design avoids routing large archive files through backend,
    improving performance and reducing memory usage.
    """

    def __init__(self):
        """Initialize MinIO client from existing S3 configuration."""
        self._client: Optional[Minio] = None
        self._bucket = ARCHIVE_BUCKET

    @property
    def client(self) -> Minio:
        """Lazy initialize MinIO client using attachment S3 config."""
        if self._client is None:
            # Reuse attachment S3 configuration
            endpoint = settings.ATTACHMENT_S3_ENDPOINT
            access_key = settings.ATTACHMENT_S3_ACCESS_KEY
            secret_key = settings.ATTACHMENT_S3_SECRET_KEY

            if not endpoint or not access_key or not secret_key:
                raise ValueError(
                    "MinIO configuration not set. "
                    "Set ATTACHMENT_S3_ENDPOINT, ATTACHMENT_S3_ACCESS_KEY, "
                    "and ATTACHMENT_S3_SECRET_KEY environment variables."
                )

            # Parse endpoint to extract host
            # Handle both http:// and https:// prefixes
            secure = settings.ATTACHMENT_S3_USE_SSL
            host = endpoint.replace("https://", "").replace("http://", "")

            self._client = Minio(
                host,
                access_key=access_key,
                secret_key=secret_key,
                secure=secure,
            )

            # Ensure bucket exists
            self._ensure_bucket()

        return self._client

    def _ensure_bucket(self) -> None:
        """Create archive bucket if it doesn't exist."""
        try:
            if not self._client.bucket_exists(self._bucket):
                self._client.make_bucket(self._bucket)
                logger.info(f"Created archive bucket: {self._bucket}")
        except S3Error as e:
            logger.error(f"Failed to create bucket {self._bucket}: {e}")
            raise

    def generate_storage_key(self, task_id: int) -> str:
        """Generate storage key for a task archive.

        Args:
            task_id: Task ID

        Returns:
            Storage key in format: workspace-archives/{task_id}/archive.tar.gz
        """
        return f"workspace-archives/{task_id}/archive.tar.gz"

    def generate_upload_url(
        self, task_id: int, expires_seconds: int = 3600
    ) -> tuple[str, str]:
        """Generate presigned URL for uploading archive.

        Args:
            task_id: Task ID
            expires_seconds: URL expiration time in seconds (default: 1 hour)

        Returns:
            Tuple of (upload_url, storage_key)
        """
        storage_key = self.generate_storage_key(task_id)

        try:
            upload_url = self.client.presigned_put_object(
                self._bucket,
                storage_key,
                expires=timedelta(seconds=expires_seconds),
            )
            logger.info(f"Generated upload URL for task {task_id}, key={storage_key}")
            return upload_url, storage_key
        except S3Error as e:
            logger.error(f"Failed to generate upload URL for task {task_id}: {e}")
            raise

    def generate_download_url(
        self, storage_key: str, expires_seconds: int = 3600
    ) -> str:
        """Generate presigned URL for downloading archive.

        Args:
            storage_key: Storage key of the archive
            expires_seconds: URL expiration time in seconds (default: 1 hour)

        Returns:
            Presigned download URL
        """
        try:
            download_url = self.client.presigned_get_object(
                self._bucket,
                storage_key,
                expires=timedelta(seconds=expires_seconds),
            )
            logger.info(f"Generated download URL for key={storage_key}")
            return download_url
        except S3Error as e:
            logger.error(f"Failed to generate download URL for {storage_key}: {e}")
            raise

    def delete_archive(self, storage_key: str) -> bool:
        """Delete an archive file from MinIO.

        Args:
            storage_key: Storage key of the archive to delete

        Returns:
            True if deleted successfully, False otherwise
        """
        try:
            self.client.remove_object(self._bucket, storage_key)
            logger.info(f"Deleted archive: {storage_key}")
            return True
        except S3Error as e:
            logger.error(f"Failed to delete archive {storage_key}: {e}")
            return False

    def archive_exists(self, storage_key: str) -> bool:
        """Check if an archive exists in MinIO.

        Args:
            storage_key: Storage key to check

        Returns:
            True if archive exists, False otherwise
        """
        try:
            self.client.stat_object(self._bucket, storage_key)
            return True
        except S3Error as e:
            if e.code == "NoSuchKey":
                return False
            logger.error(f"Error checking archive existence {storage_key}: {e}")
            raise

    def calculate_expiration_time(self) -> datetime:
        """Calculate archive expiration time based on retention days.

        Returns:
            Expiration datetime (UTC)
        """
        return datetime.utcnow() + timedelta(days=ARCHIVE_RETENTION_DAYS)


# Global service instance
archive_storage_service = ArchiveStorageService()
