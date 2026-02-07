# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
S3-compatible storage client for workspace archives.

This module provides a unified client for S3-compatible storage services
(AWS S3, MinIO, etc.) used for storing and retrieving workspace archives.

The client is designed to be lightweight and independent of database sessions,
making it suitable for use in both backend and executor modules.
"""

import logging
import os
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class S3Config:
    """Configuration for S3-compatible storage."""

    endpoint: str
    bucket: str
    access_key: str
    secret_key: str
    region: str = "us-east-1"
    use_ssl: bool = True

    @classmethod
    def from_env(cls, prefix: str = "WORKSPACE_ARCHIVE_S3") -> Optional["S3Config"]:
        """
        Create S3Config from environment variables.

        Args:
            prefix: Environment variable prefix (default: WORKSPACE_ARCHIVE_S3)

        Returns:
            S3Config instance if all required variables are set, None otherwise
        """
        endpoint = os.getenv(f"{prefix}_ENDPOINT", "")
        bucket = os.getenv(f"{prefix}_BUCKET", "")
        access_key = os.getenv(f"{prefix}_ACCESS_KEY", "")
        secret_key = os.getenv(f"{prefix}_SECRET_KEY", "")

        if not all([endpoint, bucket, access_key, secret_key]):
            return None

        region = os.getenv(f"{prefix}_REGION", "us-east-1")
        use_ssl = os.getenv(f"{prefix}_USE_SSL", "true").lower() == "true"

        return cls(
            endpoint=endpoint,
            bucket=bucket,
            access_key=access_key,
            secret_key=secret_key,
            region=region,
            use_ssl=use_ssl,
        )

    def is_valid(self) -> bool:
        """Check if the configuration has all required fields."""
        return all([self.endpoint, self.bucket, self.access_key, self.secret_key])


class S3Client:
    """
    S3-compatible storage client for workspace archives.

    This client provides basic operations for uploading, downloading,
    and deleting workspace archive files from S3-compatible storage.
    """

    def __init__(self, config: S3Config):
        """
        Initialize S3 client with configuration.

        Args:
            config: S3Config instance with connection details
        """
        self.config = config
        self._client = None

    def _get_client(self):
        """Get or create boto3 S3 client (lazy initialization)."""
        if self._client is None:
            try:
                import boto3
                from botocore.config import Config as BotoConfig

                boto_config = BotoConfig(
                    signature_version="s3v4",
                    retries={"max_attempts": 3, "mode": "standard"},
                )

                self._client = boto3.client(
                    "s3",
                    endpoint_url=self.config.endpoint,
                    aws_access_key_id=self.config.access_key,
                    aws_secret_access_key=self.config.secret_key,
                    region_name=self.config.region,
                    use_ssl=self.config.use_ssl,
                    config=boto_config,
                )
                logger.debug(
                    f"Initialized S3 client for endpoint: {self.config.endpoint}"
                )
            except ImportError:
                raise ImportError(
                    "boto3 is required for S3 storage. "
                    "Install it with: pip install boto3"
                )
        return self._client

    def upload_file(
        self,
        local_path: str,
        key: str,
        content_type: str = "application/gzip",
    ) -> bool:
        """
        Upload a file to S3.

        Args:
            local_path: Path to the local file to upload
            key: S3 object key (path in bucket)
            content_type: MIME type of the file

        Returns:
            True if upload succeeded, False otherwise
        """
        try:
            client = self._get_client()
            client.upload_file(
                local_path,
                self.config.bucket,
                key,
                ExtraArgs={"ContentType": content_type},
            )
            logger.info(f"Uploaded file to S3: {key}")
            return True
        except Exception as e:
            logger.error(f"Failed to upload file to S3 ({key}): {e}")
            return False

    def upload_bytes(
        self,
        data: bytes,
        key: str,
        content_type: str = "application/gzip",
    ) -> bool:
        """
        Upload bytes data to S3.

        Args:
            data: Bytes data to upload
            key: S3 object key (path in bucket)
            content_type: MIME type of the data

        Returns:
            True if upload succeeded, False otherwise
        """
        try:
            from io import BytesIO

            client = self._get_client()
            client.upload_fileobj(
                BytesIO(data),
                self.config.bucket,
                key,
                ExtraArgs={"ContentType": content_type},
            )
            logger.info(f"Uploaded bytes to S3: {key} ({len(data)} bytes)")
            return True
        except Exception as e:
            logger.error(f"Failed to upload bytes to S3 ({key}): {e}")
            return False

    def download_file(self, key: str, local_path: str) -> bool:
        """
        Download a file from S3.

        Args:
            key: S3 object key (path in bucket)
            local_path: Path to save the downloaded file

        Returns:
            True if download succeeded, False otherwise
        """
        try:
            client = self._get_client()
            client.download_file(self.config.bucket, key, local_path)
            logger.info(f"Downloaded file from S3: {key} -> {local_path}")
            return True
        except Exception as e:
            logger.error(f"Failed to download file from S3 ({key}): {e}")
            return False

    def download_bytes(self, key: str) -> Optional[bytes]:
        """
        Download data from S3 as bytes.

        Args:
            key: S3 object key (path in bucket)

        Returns:
            Downloaded bytes data, or None if failed
        """
        try:
            from io import BytesIO

            client = self._get_client()
            buffer = BytesIO()
            client.download_fileobj(self.config.bucket, key, buffer)
            buffer.seek(0)
            data = buffer.read()
            logger.info(f"Downloaded bytes from S3: {key} ({len(data)} bytes)")
            return data
        except Exception as e:
            logger.error(f"Failed to download bytes from S3 ({key}): {e}")
            return None

    def delete(self, key: str) -> bool:
        """
        Delete an object from S3.

        Args:
            key: S3 object key (path in bucket)

        Returns:
            True if deletion succeeded, False otherwise
        """
        try:
            client = self._get_client()
            client.delete_object(Bucket=self.config.bucket, Key=key)
            logger.info(f"Deleted object from S3: {key}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete object from S3 ({key}): {e}")
            return False

    def exists(self, key: str) -> bool:
        """
        Check if an object exists in S3.

        Args:
            key: S3 object key (path in bucket)

        Returns:
            True if object exists, False otherwise
        """
        try:
            client = self._get_client()
            client.head_object(Bucket=self.config.bucket, Key=key)
            return True
        except Exception:
            return False

    def get_presigned_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """
        Generate a presigned URL for downloading an object.

        Args:
            key: S3 object key (path in bucket)
            expires: URL expiration time in seconds (default: 1 hour)

        Returns:
            Presigned URL string, or None if failed
        """
        try:
            client = self._get_client()
            url = client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.config.bucket, "Key": key},
                ExpiresIn=expires,
            )
            return url
        except Exception as e:
            logger.error(f"Failed to generate presigned URL for {key}: {e}")
            return None


def get_workspace_archive_s3_client() -> Optional[S3Client]:
    """
    Get S3 client for workspace archives from environment configuration.

    Returns:
        S3Client instance if configuration is valid, None otherwise
    """
    config = S3Config.from_env("WORKSPACE_ARCHIVE_S3")
    if config is None or not config.is_valid():
        logger.debug("Workspace archive S3 is not configured")
        return None
    return S3Client(config)


def is_workspace_archive_enabled() -> bool:
    """
    Check if workspace archive feature is enabled.

    The feature is enabled when:
    1. WORKSPACE_ARCHIVE_ENABLED is set to "true"
    2. All required S3 configuration is provided

    Returns:
        True if workspace archive is enabled and configured
    """
    enabled = os.getenv("WORKSPACE_ARCHIVE_ENABLED", "false").lower() == "true"
    if not enabled:
        return False

    config = S3Config.from_env("WORKSPACE_ARCHIVE_S3")
    return config is not None and config.is_valid()
