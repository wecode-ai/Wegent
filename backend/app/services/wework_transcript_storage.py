# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private object storage for archived Wework transcripts."""

import hashlib
from datetime import UTC, datetime, timedelta

from minio import Minio
from minio.datatypes import PostPolicy
from urllib3 import PoolManager, Timeout

from app.core.config import settings


class WeworkTranscriptStorageError(RuntimeError):
    """Raised when transcript object storage is unavailable."""


class WeworkTranscriptStorage:
    def __init__(self) -> None:
        self._client: Minio | None = None

    @property
    def bucket(self) -> str:
        return settings.WEWORK_TRANSCRIPT_S3_BUCKET

    @property
    def client(self) -> Minio:
        if self._client is None:
            endpoint = settings.ATTACHMENT_S3_ENDPOINT
            access_key = settings.ATTACHMENT_S3_ACCESS_KEY
            secret_key = settings.ATTACHMENT_S3_SECRET_KEY
            if not endpoint or not access_key or not secret_key:
                raise WeworkTranscriptStorageError(
                    "Wework transcript object storage is unavailable"
                )
            client = Minio(
                endpoint.replace("https://", "").replace("http://", ""),
                access_key=access_key,
                secret_key=secret_key,
                secure=settings.ATTACHMENT_S3_USE_SSL,
                region=settings.ATTACHMENT_S3_REGION,
                http_client=PoolManager(
                    timeout=Timeout(connect=3.0, read=30.0),
                    retries=False,
                ),
            )
            try:
                if not client.bucket_exists(self.bucket):
                    client.make_bucket(self.bucket)
            except Exception as exc:
                raise WeworkTranscriptStorageError(
                    "Wework transcript object storage is unavailable"
                ) from exc
            self._client = client
        return self._client

    def download_url(self, object_key: str) -> str:
        try:
            return self.client.presigned_get_object(
                self.bucket,
                object_key,
                expires=timedelta(
                    seconds=settings.WEWORK_TRANSCRIPT_DOWNLOAD_URL_EXPIRE_SECONDS
                ),
            )
        except Exception as exc:
            raise WeworkTranscriptStorageError(
                "Failed to create archived transcript download URL"
            ) from exc

    def upload_policy(
        self,
        object_key: str,
        size_bytes: int,
    ) -> tuple[str, dict[str, str], datetime]:
        try:
            expires = settings.WEWORK_TRANSCRIPT_DOWNLOAD_URL_EXPIRE_SECONDS
            expires_at = datetime.now(UTC) + timedelta(seconds=expires)
            policy = PostPolicy(self.bucket, expires_at)
            policy.add_equals_condition("key", object_key)
            policy.add_content_length_range_condition(size_bytes, size_bytes)
            fields = self.client.presigned_post_policy(policy)
            endpoint = settings.ATTACHMENT_S3_ENDPOINT.rstrip("/")
            if not endpoint.startswith(("http://", "https://")):
                scheme = "https" if settings.ATTACHMENT_S3_USE_SSL else "http"
                endpoint = f"{scheme}://{endpoint}"
            upload_url = f"{endpoint}/{self.bucket}"
            return upload_url, fields, expires_at
        except Exception as exc:
            raise WeworkTranscriptStorageError(
                "Failed to create transcript segment upload policy"
            ) from exc

    def integrity(self, object_key: str, max_bytes: int) -> tuple[int, str]:
        response = None
        try:
            response = self.client.get_object(self.bucket, object_key)
            digest = hashlib.sha256()
            size = 0
            for chunk in response.stream(amt=1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    return size, ""
                digest.update(chunk)
            return size, digest.hexdigest()
        except Exception as exc:
            raise WeworkTranscriptStorageError(
                "Failed to verify uploaded transcript segment"
            ) from exc
        finally:
            if response is not None:
                response.close()
                response.release_conn()

    def delete(self, object_key: str) -> None:
        try:
            self.client.remove_object(self.bucket, object_key)
        except Exception as exc:
            raise WeworkTranscriptStorageError(
                "Failed to delete obsolete transcript segment"
            ) from exc


wework_transcript_storage = WeworkTranscriptStorage()
