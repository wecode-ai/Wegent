# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Assemble the real Backend with an application-owned MinIO media extension.

The public repository deliberately does not ship an internal media provider.
This extension resolves actual stored objects (including legacy opaque FIDs),
checks their owner metadata and provides URLs the model can actually download.
It does not replace any upload, persistence, auth, chat or MCP implementation.
"""

import json
import os
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from minio import Minio
from minio.error import S3Error

from app.services.attachment import StorageBackend, register_storage_backend
from app.services.execution.agents.video.extensions import (
    register_video_generation_extension,
)


class MinioMediaExtension(StorageBackend):
    def __init__(self) -> None:
        self.endpoint = os.environ["E2E_MINIO_URL"].rstrip("/")
        self.bucket = os.environ["E2E_MEDIA_BUCKET"]
        self.store = Minio(
            urlparse(self.endpoint).netloc,
            access_key=os.environ["E2E_MINIO_ROOT_USER"],
            secret_key=os.environ["E2E_MINIO_ROOT_PASSWORD"],
            secure=False,
        )

    @property
    def backend_type(self) -> str:
        return "media_minio"

    def save(self, key: str, data: bytes, metadata: dict) -> str:
        self.store.put_object(
            self.bucket,
            key,
            BytesIO(data),
            len(data),
            content_type=metadata.get("mime_type", "application/octet-stream"),
            metadata={"user_id": str(metadata["user_id"])},
        )
        return key

    def get(self, key: str) -> bytes:
        response = self.store.get_object(self.bucket, key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def delete(self, key: str) -> bool:
        self.store.remove_object(self.bucket, key)
        return True

    def exists(self, key: str) -> bool:
        try:
            self.store.stat_object(self.bucket, key)
            return True
        except S3Error as exc:
            if exc.code == "NoSuchKey":
                return False
            raise

    def get_url(self, key: str, expires: int = 3600) -> str:
        return f"{self.endpoint}/{self.bucket}/{quote(key, safe='/')}"

    def resolve_material(
        self,
        *,
        type_data: dict[str, Any],
        media_type: str,
        user_id: int,
        attachment_id: int,
    ) -> dict[str, Any] | None:
        hosted = type_data.get("hosted_media") or {}
        media_id = hosted.get("media_id") or type_data.get("legacy_fid")
        if not media_id:
            return None
        stat = self.store.stat_object(self.bucket, media_id)
        if int(stat.metadata["x-amz-meta-user_id"]) != user_id:
            raise ValueError("Hosted media owner does not match the current user")
        if not stat.content_type.startswith(media_type + "/"):
            raise ValueError("Hosted media type does not match its attachment")
        descriptor = {
            "hosted_media_id": media_id,
            "user_id": user_id,
            "attachment_id": attachment_id,
        }
        with (Path(os.environ["E2E_REPORT_DIR"]) / "resolution.jsonl").open("a") as log:
            log.write(json.dumps({**descriptor, "media_type": media_type}) + "\n")
        return descriptor

    def build_provider_content(
        self, *, protocol: str, media_type: str, descriptor: dict[str, Any], role: str
    ) -> dict[str, Any] | None:
        media_id = descriptor.get("hosted_media_id")
        if protocol != "seedance" or not media_id:
            return None
        media_key = f"{media_type}_url"
        url = self.get_url(media_id)
        return {"type": media_key, media_key: {"url": url}, "role": role}

    def parse_status(self, response: dict[str, Any], fallback: Any) -> None:
        return None

    def parse_result(self, response: dict[str, Any], fallback: Any) -> None:
        return None

    def prepare_result(self, **kwargs: Any) -> None:
        return None

    def refresh_result_urls(self, **kwargs: Any) -> None:
        pass


extension = MinioMediaExtension()
register_video_generation_extension(extension)
register_storage_backend("media_minio", lambda db: extension)

from app.main import app  # noqa: E402,F401
