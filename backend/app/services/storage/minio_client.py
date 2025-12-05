# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MinIO client service for object storage operations.

Handles file uploads, downloads, and deletions for attachment storage.
"""

import logging
from typing import Optional

from minio import Minio
from minio.error import S3Error

from app.core.config import settings

logger = logging.getLogger(__name__)


class MinioClient:
    """
    MinIO client wrapper for object storage operations.

    Provides methods for uploading, downloading, and deleting files
    in MinIO object storage.
    """

    def __init__(self):
        """Initialize MinIO client with configuration from settings."""
        self._client: Optional[Minio] = None
        self._bucket_ensured = False

    @property
    def client(self) -> Minio:
        """
        Get or create MinIO client instance (lazy initialization).

        Returns:
            Minio client instance
        """
        if self._client is None:
            self._client = Minio(
                endpoint=settings.MINIO_ENDPOINT,
                access_key=settings.MINIO_ACCESS_KEY,
                secret_key=settings.MINIO_SECRET_KEY,
                secure=settings.MINIO_SECURE,
            )
            logger.info(f"MinIO client initialized with endpoint: {settings.MINIO_ENDPOINT}")
        return self._client

    def _ensure_bucket(self) -> None:
        """
        Ensure the configured bucket exists, create if not.

        This is called lazily on first operation.
        """
        if self._bucket_ensured:
            return

        bucket_name = settings.MINIO_BUCKET_NAME
        try:
            if not self.client.bucket_exists(bucket_name):
                self.client.make_bucket(bucket_name)
                logger.info(f"Created MinIO bucket: {bucket_name}")
            else:
                logger.debug(f"MinIO bucket exists: {bucket_name}")
            self._bucket_ensured = True
        except S3Error as e:
            logger.error(f"Failed to ensure bucket {bucket_name}: {e}")
            raise

    def generate_object_key(
        self,
        user_id: int,
        attachment_id: int,
        original_filename: str,
    ) -> str:
        """
        Generate object key for storing attachment.

        Args:
            user_id: User ID
            attachment_id: Attachment record ID
            original_filename: Original filename

        Returns:
            Object key path: attachments/{user_id}/{attachment_id}/{original_filename}
        """
        return f"attachments/{user_id}/{attachment_id}/{original_filename}"

    def upload_file(
        self,
        object_key: str,
        data: bytes,
        content_type: str,
    ) -> str:
        """
        Upload file to MinIO.

        Args:
            object_key: Object key/path in bucket
            data: File binary data
            content_type: MIME type of the file

        Returns:
            Object key of uploaded file

        Raises:
            S3Error: If upload fails
        """
        self._ensure_bucket()

        from io import BytesIO

        bucket_name = settings.MINIO_BUCKET_NAME
        data_stream = BytesIO(data)
        data_length = len(data)

        try:
            self.client.put_object(
                bucket_name=bucket_name,
                object_name=object_key,
                data=data_stream,
                length=data_length,
                content_type=content_type,
            )
            logger.info(f"Uploaded file to MinIO: {bucket_name}/{object_key} ({data_length} bytes)")
            return object_key
        except S3Error as e:
            logger.error(f"Failed to upload file to MinIO: {object_key}, error: {e}")
            raise

    def download_file(self, object_key: str) -> bytes:
        """
        Download file from MinIO.

        Args:
            object_key: Object key/path in bucket

        Returns:
            File binary data

        Raises:
            S3Error: If download fails
        """
        bucket_name = settings.MINIO_BUCKET_NAME

        try:
            response = self.client.get_object(
                bucket_name=bucket_name,
                object_name=object_key,
            )
            data = response.read()
            response.close()
            response.release_conn()
            logger.debug(f"Downloaded file from MinIO: {bucket_name}/{object_key} ({len(data)} bytes)")
            return data
        except S3Error as e:
            logger.error(f"Failed to download file from MinIO: {object_key}, error: {e}")
            raise

    def delete_file(self, object_key: str) -> bool:
        """
        Delete file from MinIO.

        Args:
            object_key: Object key/path in bucket

        Returns:
            True if deleted successfully, False otherwise
        """
        bucket_name = settings.MINIO_BUCKET_NAME

        try:
            self.client.remove_object(
                bucket_name=bucket_name,
                object_name=object_key,
            )
            logger.info(f"Deleted file from MinIO: {bucket_name}/{object_key}")
            return True
        except S3Error as e:
            logger.error(f"Failed to delete file from MinIO: {object_key}, error: {e}")
            return False

    def file_exists(self, object_key: str) -> bool:
        """
        Check if file exists in MinIO.

        Args:
            object_key: Object key/path in bucket

        Returns:
            True if file exists, False otherwise
        """
        bucket_name = settings.MINIO_BUCKET_NAME

        try:
            self.client.stat_object(
                bucket_name=bucket_name,
                object_name=object_key,
            )
            return True
        except S3Error as e:
            if e.code == "NoSuchKey":
                return False
            logger.error(f"Failed to check file existence in MinIO: {object_key}, error: {e}")
            return False


# Global MinIO client instance
minio_client = MinioClient()
