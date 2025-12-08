# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MinIO/S3 storage backend implementation.

This module provides a MinIO/S3-based storage backend that stores
binary data in object storage. It supports both MinIO and AWS S3.
"""

import logging
from datetime import timedelta
from io import BytesIO
from typing import Dict, Optional
from urllib.parse import quote

from minio import Minio
from minio.error import S3Error
from sqlalchemy.orm import Session
from urllib3.exceptions import MaxRetryError

from app.models.subtask_attachment import SubtaskAttachment
from app.services.attachment.storage_backend import StorageBackend, StorageError

logger = logging.getLogger(__name__)


class MinIOStorageBackend(StorageBackend):
    """
    MinIO/S3 storage backend implementation.

    Stores binary data in MinIO or S3-compatible object storage.
    Supports presigned URLs for direct file access.
    """

    BACKEND_TYPE = "minio"

    def __init__(
        self,
        db: Session,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        region: str = "us-east-1",
        use_ssl: bool = True,
    ):
        """
        Initialize MinIO storage backend.

        Args:
            db: SQLAlchemy database session
            endpoint: MinIO/S3 endpoint URL (e.g., "minio:9000" or "s3.amazonaws.com")
            access_key: Access key for authentication
            secret_key: Secret key for authentication
            bucket: Bucket name for storing attachments
            region: Region for the bucket (default: "us-east-1")
            use_ssl: Whether to use SSL/TLS (default: True)
        """
        self._db = db
        self._endpoint = endpoint
        self._bucket = bucket
        self._region = region

        # Remove protocol prefix if present
        endpoint_clean = endpoint
        if endpoint_clean.startswith("http://"):
            endpoint_clean = endpoint_clean[7:]
            use_ssl = False
        elif endpoint_clean.startswith("https://"):
            endpoint_clean = endpoint_clean[8:]
            use_ssl = True

        # Initialize MinIO client
        self._client = Minio(
            endpoint_clean,
            access_key=access_key,
            secret_key=secret_key,
            secure=use_ssl,
            region=region,
        )

        # Ensure bucket exists
        self._ensure_bucket_exists()

    def _ensure_bucket_exists(self) -> None:
        """Create the bucket if it doesn't exist."""
        try:
            if not self._client.bucket_exists(self._bucket):
                self._client.make_bucket(self._bucket, location=self._region)
                logger.info(f"Created MinIO bucket: {self._bucket}")
        except S3Error as e:
            logger.error(f"Failed to create bucket {self._bucket}: {e}")
            raise StorageError(f"Failed to create bucket: {e}")
        except MaxRetryError as e:
            logger.error(f"Failed to connect to MinIO endpoint {self._endpoint}: {e}")
            raise StorageError(f"Failed to connect to MinIO: {e}")

    @property
    def backend_type(self) -> str:
        """Get the backend type identifier."""
        return self.BACKEND_TYPE

    def _encode_metadata_value(self, value: str) -> str:
        """
        Encode metadata value to be ASCII-safe for MinIO/S3.

        MinIO/S3 metadata values must be US-ASCII encoded.
        Non-ASCII characters are URL-encoded to ensure compatibility.

        Args:
            value: The metadata value to encode

        Returns:
            ASCII-safe encoded string
        """
        if not value:
            return ""
        # URL-encode non-ASCII characters
        # safe='' ensures all non-ASCII chars are encoded
        return quote(value, safe="")

    def save(self, key: str, data: bytes, metadata: Dict) -> str:
        """
        Save file data to MinIO.

        Args:
            key: Storage key (format: attachments/{uuid}_{timestamp}_{user_id}_{attachment_id})
            data: File binary data
            metadata: Additional metadata (filename, mime_type, etc.)

        Returns:
            The storage key

        Raises:
            StorageError: If save operation fails
        """
        try:
            # Prepare content type from metadata
            content_type = metadata.get("mime_type", "application/octet-stream")

            # Encode filename for ASCII-safe metadata
            # MinIO/S3 metadata only supports US-ASCII characters
            filename = metadata.get("filename", "")
            encoded_filename = self._encode_metadata_value(filename)

            # Upload to MinIO
            data_stream = BytesIO(data)
            self._client.put_object(
                self._bucket,
                key,
                data_stream,
                length=len(data),
                content_type=content_type,
                metadata={
                    "filename": encoded_filename,
                    "user_id": str(metadata.get("user_id", "")),
                },
            )

            # Update attachment record to clear binary_data (stored externally now)
            attachment_id = self._extract_attachment_id(key)
            attachment = (
                self._db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.id == attachment_id)
                .first()
            )

            if attachment:
                # Clear binary_data since it's now stored in MinIO
                attachment.binary_data = b""
                attachment.storage_backend = self.BACKEND_TYPE
                attachment.storage_key = key
                self._db.flush()

            logger.debug(f"Saved file to MinIO: {key}")
            return key

        except S3Error as e:
            logger.error(f"Failed to save to MinIO: {e}")
            raise StorageError(f"Failed to save data to MinIO: {e}", key)
        except Exception as e:
            logger.error(f"Unexpected error saving to MinIO: {e}")
            raise StorageError(f"Failed to save data: {e}", key)

    def get(self, key: str) -> Optional[bytes]:
        """
        Get file data from MinIO.

        Args:
            key: Storage key

        Returns:
            File binary data, or None if not found
        """
        try:
            response = self._client.get_object(self._bucket, key)
            data = response.read()
            response.close()
            response.release_conn()
            return data

        except S3Error as e:
            if e.code == "NoSuchKey":
                logger.debug(f"Object not found in MinIO: {key}")
                return None
            logger.error(f"Failed to get from MinIO: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error getting from MinIO: {e}")
            return None

    def delete(self, key: str) -> bool:
        """
        Delete file from MinIO.

        Args:
            key: Storage key

        Returns:
            True if deleted successfully, False otherwise
        """
        try:
            self._client.remove_object(self._bucket, key)
            logger.debug(f"Deleted file from MinIO: {key}")
            return True

        except S3Error as e:
            if e.code == "NoSuchKey":
                logger.debug(f"Object not found for deletion in MinIO: {key}")
                return True  # Consider it deleted if it doesn't exist
            logger.error(f"Failed to delete from MinIO: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error deleting from MinIO: {e}")
            return False

    def exists(self, key: str) -> bool:
        """
        Check if file exists in MinIO.

        Args:
            key: Storage key

        Returns:
            True if file exists, False otherwise
        """
        try:
            self._client.stat_object(self._bucket, key)
            return True

        except S3Error as e:
            if e.code == "NoSuchKey":
                return False
            logger.error(f"Failed to check existence in MinIO: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error checking existence in MinIO: {e}")
            return False

    def get_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """
        Get a presigned URL for accessing the file.

        Args:
            key: Storage key
            expires: URL expiration time in seconds (default: 3600)

        Returns:
            Presigned URL string
        """
        try:
            url = self._client.presigned_get_object(
                self._bucket,
                key,
                expires=timedelta(seconds=expires),
            )
            return url

        except S3Error as e:
            logger.error(f"Failed to generate presigned URL: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error generating presigned URL: {e}")
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
            key_parts = parts[1].split("_")
            if len(key_parts) < 4:
                raise ValueError(
                    "Invalid key format: expected uuid_timestamp_userid_attachmentid"
                )

            # The attachment_id is the last part
            return int(key_parts[-1])
        except (ValueError, IndexError) as e:
            raise StorageError(f"Invalid storage key format: {key}", key)