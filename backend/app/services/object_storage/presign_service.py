# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Presigned URL generation for object storage."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from minio import Minio

from app.core.config import settings

logger = logging.getLogger(__name__)


class ObjectStoragePresignService:
    """Generate presigned object storage URLs using attachment S3 settings."""

    def __init__(self) -> None:
        self._client: Optional[Minio] = None

    @property
    def client(self) -> Minio:
        """Lazy initialize a MinIO client from attachment S3 configuration."""
        if self._client is None:
            endpoint = settings.ATTACHMENT_S3_ENDPOINT
            access_key = settings.ATTACHMENT_S3_ACCESS_KEY
            secret_key = settings.ATTACHMENT_S3_SECRET_KEY

            if not endpoint or not access_key or not secret_key:
                raise ValueError(
                    "MinIO configuration not set. "
                    "Set ATTACHMENT_S3_ENDPOINT, ATTACHMENT_S3_ACCESS_KEY, "
                    "and ATTACHMENT_S3_SECRET_KEY environment variables."
                )

            secure = settings.ATTACHMENT_S3_USE_SSL
            host = endpoint.replace("https://", "").replace("http://", "")

            self._client = Minio(
                host,
                access_key=access_key,
                secret_key=secret_key,
                secure=secure,
                region=settings.ATTACHMENT_S3_REGION,
            )

        return self._client

    def generate_upload_url(
        self,
        *,
        bucket: str,
        object_key: str,
        expires_seconds: int,
    ) -> tuple[str, datetime]:
        """Generate a presigned PUT URL for one object."""
        upload_url = self.client.presigned_put_object(
            bucket,
            object_key,
            expires=timedelta(seconds=expires_seconds),
        )
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_seconds)
        logger.info(
            "Generated presigned upload URL for bucket=%s key=%s",
            bucket,
            object_key,
        )
        return upload_url, expires_at

    def generate_download_url(
        self,
        *,
        bucket: str,
        object_key: str,
        expires_seconds: int,
    ) -> tuple[str, datetime]:
        """Generate a presigned GET URL for one object."""
        download_url = self.client.presigned_get_object(
            bucket,
            object_key,
            expires=timedelta(seconds=expires_seconds),
        )
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_seconds)
        logger.info(
            "Generated presigned download URL for bucket=%s key=%s",
            bucket,
            object_key,
        )
        return download_url, expires_at


object_storage_presign_service = ObjectStoragePresignService()
