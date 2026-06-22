# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Presigned URL generation for object storage."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlunsplit

from minio import Minio
from minio.helpers import check_bucket_name, check_object_name
from minio.signer import presign_v4

from app.core.config import settings

logger = logging.getLogger(__name__)

MAX_MINIO_CLIENT_PRESIGN_SECONDS = 7 * 24 * 60 * 60


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
        if expires_seconds <= MAX_MINIO_CLIENT_PRESIGN_SECONDS:
            download_url = self.client.presigned_get_object(
                bucket,
                object_key,
                expires=timedelta(seconds=expires_seconds),
            )
        else:
            download_url = self._generate_long_lived_download_url(
                bucket=bucket,
                object_key=object_key,
                expires_seconds=expires_seconds,
            )
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_seconds)
        logger.info(
            "Generated presigned download URL for bucket=%s key=%s",
            bucket,
            object_key,
        )
        return download_url, expires_at

    def _generate_long_lived_download_url(
        self,
        *,
        bucket: str,
        object_key: str,
        expires_seconds: int,
    ) -> str:
        """Generate a GET URL beyond the MinIO client presign limit."""
        client = self.client
        check_bucket_name(bucket, s3_check=client._base_url.is_aws_host)
        check_object_name(object_key)
        if expires_seconds < 1:
            raise ValueError("expires_seconds must be greater than 0")

        region = client._get_region(bucket)
        creds = client._provider.retrieve() if client._provider else None
        query_params = {}
        if creds and creds.session_token:
            query_params["X-Amz-Security-Token"] = creds.session_token

        url = client._base_url.build(
            method="GET",
            region=region,
            bucket_name=bucket,
            object_name=object_key,
            query_params=query_params,
        )

        if creds:
            url = presign_v4(
                method="GET",
                url=url,
                region=region,
                credentials=creds,
                date=datetime.now(timezone.utc),
                expires=expires_seconds,
            )

        return urlunsplit(url)


object_storage_presign_service = ObjectStoragePresignService()
