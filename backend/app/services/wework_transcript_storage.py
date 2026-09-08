# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private object storage for archived Wework transcripts."""

import io
from datetime import timedelta
from typing import Optional

from minio import Minio
from urllib3 import PoolManager, Timeout

from app.core.config import settings


class WeworkTranscriptStorageError(RuntimeError):
    """Raised when transcript object storage is unavailable."""


class WeworkTranscriptStorage:
    def __init__(self) -> None:
        self._client: Optional[Minio] = None

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

    def put(self, object_key: str, content: bytes) -> None:
        try:
            self.client.put_object(
                self.bucket,
                object_key,
                io.BytesIO(content),
                len(content),
                content_type="application/zstd",
            )
        except Exception as exc:
            raise WeworkTranscriptStorageError(
                "Failed to store archived Wework transcript"
            ) from exc

    def get(self, object_key: str) -> bytes:
        response = None
        try:
            response = self.client.get_object(self.bucket, object_key)
            return response.read()
        except Exception as exc:
            raise WeworkTranscriptStorageError(
                "Failed to read archived Wework transcript"
            ) from exc
        finally:
            if response is not None:
                response.close()
                response.release_conn()

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


wework_transcript_storage = WeworkTranscriptStorage()
