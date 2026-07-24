# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MinIO object storage boundary for immutable delivery snapshots."""

import io
import json
from datetime import timedelta
from typing import Any, BinaryIO, Optional

from minio import Minio
from minio.commonconfig import CopySource
from urllib3 import PoolManager, Timeout

from app.core.config import settings


class DeliveryStorageUnavailableError(RuntimeError):
    """Raised when the delivery object store cannot serve a request."""


class DeliveryStorage:
    """Store delivery objects in a dedicated private bucket."""

    def __init__(self) -> None:
        self._client: Optional[Minio] = None

    @property
    def bucket(self) -> str:
        return settings.DELIVERY_S3_BUCKET

    @property
    def client(self) -> Minio:
        if self._client is None:
            endpoint = settings.ATTACHMENT_S3_ENDPOINT
            access_key = settings.ATTACHMENT_S3_ACCESS_KEY
            secret_key = settings.ATTACHMENT_S3_SECRET_KEY
            if not endpoint or not access_key or not secret_key:
                raise ValueError("MinIO credentials are not configured")
            self._client = Minio(
                endpoint.replace("https://", "").replace("http://", ""),
                access_key=access_key,
                secret_key=secret_key,
                secure=settings.ATTACHMENT_S3_USE_SSL,
                region=settings.ATTACHMENT_S3_REGION,
                http_client=PoolManager(
                    timeout=Timeout(connect=3.0, read=10.0),
                    retries=False,
                ),
            )
            try:
                if not self._client.bucket_exists(self.bucket):
                    self._client.make_bucket(self.bucket)
            except Exception as exc:
                self._client = None
                raise DeliveryStorageUnavailableError(
                    "Delivery object storage is unavailable"
                ) from exc
        return self._client

    def put_bytes(self, object_key: str, content: bytes, content_type: str) -> None:
        self.client.put_object(
            self.bucket,
            object_key,
            io.BytesIO(content),
            len(content),
            content_type=content_type,
        )

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        self.client.put_object(
            self.bucket,
            object_key,
            stream,
            length,
            content_type=content_type,
        )

    def put_json(self, object_key: str, value: Any) -> None:
        self.put_bytes(
            object_key,
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(),
            "application/json",
        )

    def get_bytes(self, object_key: str, max_bytes: int | None = None) -> bytes:
        response = self.client.get_object(self.bucket, object_key)
        try:
            data = response.read(max_bytes + 1 if max_bytes is not None else None)
            if max_bytes is not None and len(data) > max_bytes:
                raise ValueError("Delivery object exceeds the readable size limit")
            return data
        finally:
            response.close()
            response.release_conn()

    def download_url(self, object_key: str, expires_seconds: int = 900) -> str:
        return self.client.presigned_get_object(
            self.bucket,
            object_key,
            expires=timedelta(seconds=expires_seconds),
        )

    def remove_objects(self, object_keys: list[str]) -> None:
        for object_key in object_keys:
            self.client.remove_object(self.bucket, object_key)

    def copy_object(self, source_key: str, target_key: str) -> None:
        self.client.copy_object(
            self.bucket,
            target_key,
            CopySource(self.bucket, source_key),
        )


delivery_storage = DeliveryStorage()
