# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private object storage for archived Wework transcripts."""

import logging
from typing import BinaryIO, Iterator

from minio import Minio
from urllib3 import PoolManager, Timeout

from app.core.config import settings

logger = logging.getLogger(__name__)


class WeworkTranscriptStorageError(RuntimeError):
    """Raised when transcript object storage is unavailable."""

    code = "transcript_storage_unavailable"


def _failure(
    operation: str,
    exc: Exception,
    **context: object,
) -> WeworkTranscriptStorageError:
    """Log the underlying object-storage failure and describe it to the caller.

    The reported reason distinguishes an authorization failure from a missing
    bucket or an unreachable endpoint; without it every failure looks identical
    to whoever reads the error on the device.
    """
    reason = _reason(exc)
    logger.error(operation, exc_info=True, extra={**context, "storage_reason": reason})
    return WeworkTranscriptStorageError(f"{operation} ({reason})")


def _reason(exc: Exception) -> str:
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code:
        return code
    return type(exc).__name__


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
                logger.error(
                    "Wework transcript object storage is not configured",
                    extra={
                        "endpoint_configured": bool(endpoint),
                        "access_key_configured": bool(access_key),
                        "secret_key_configured": bool(secret_key),
                    },
                )
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
                    logger.info(
                        "Created Wework transcript bucket",
                        extra={"bucket": self.bucket},
                    )
            except Exception as exc:
                raise _failure(
                    "Wework transcript object storage is unavailable",
                    exc,
                    bucket=self.bucket,
                ) from exc
            self._client = client
        return self._client

    def stream(self, object_key: str) -> Iterator[bytes]:
        client = self.client
        try:
            response = client.get_object(self.bucket, object_key)
        except Exception as exc:
            raise _failure(
                "Failed to read transcript segment",
                exc,
                bucket=self.bucket,
            ) from exc
        return self._stream_response(response)

    @staticmethod
    def _stream_response(response) -> Iterator[bytes]:
        try:
            yield from response.stream(amt=1024 * 1024)
        finally:
            response.close()
            response.release_conn()

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        size_bytes: int,
    ) -> None:
        client = self.client
        try:
            client.put_object(
                self.bucket,
                object_key,
                stream,
                size_bytes,
                content_type="application/octet-stream",
            )
        except Exception as exc:
            raise _failure(
                "Failed to store transcript segment",
                exc,
                bucket=self.bucket,
            ) from exc

    def delete(self, object_key: str) -> None:
        client = self.client
        try:
            client.remove_object(self.bucket, object_key)
        except Exception as exc:
            raise _failure(
                "Failed to delete obsolete transcript segment",
                exc,
                bucket=self.bucket,
            ) from exc


wework_transcript_storage = WeworkTranscriptStorage()
