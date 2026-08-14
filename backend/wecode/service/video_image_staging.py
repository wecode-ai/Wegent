# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Aliyun OSS staging for images sent to internal video models."""

import asyncio
import base64
import binascii
import hashlib
import logging
import mimetypes
import time
import uuid
from typing import Any, Optional
from urllib.parse import quote

import httpx

from app.core.cache import cache_manager
from app.core.config import settings
from app.services.execution.agents.video.image_staging import (
    VideoImageStagingBackend,
    register_video_image_staging_backend,
)
from wecode.config.video_image_staging_config import (
    VideoImageStagingSettings,
    video_image_staging_settings,
)

logger = logging.getLogger(__name__)

_CACHE_PREFIX = "video_image_oss"
_LOCK_SECONDS = 30
_LOCK_WAIT_SECONDS = 10
_MIN_REMAINING_SECONDS = 300


class OssVideoImageStagingBackend(VideoImageStagingBackend):
    """Stage video reference images in a short-lived private OSS bucket."""

    def __init__(
        self,
        config: VideoImageStagingSettings,
        bucket: Any = None,
        cache: Any = cache_manager,
    ) -> None:
        self._config = config
        self._bucket_override = bucket
        self._cache = cache
        self._bucket_instance: Any = None

    async def stage(
        self,
        images: list[dict[str, Any]],
        user_id: int,
    ) -> list[dict[str, Any]]:
        self._validate_config()
        return await asyncio.gather(
            *(self._stage_one(image, user_id) for image in images)
        )

    async def _stage_one(
        self,
        image: dict[str, Any],
        user_id: int,
    ) -> dict[str, Any]:
        fingerprint = self._fingerprint(image)
        cache_key = f"{_CACHE_PREFIX}:object:{fingerprint}"
        cached = await self._get_cached_object(cache_key)
        if cached:
            return self._with_staged_url(image, cached)

        lock_key = f"{_CACHE_PREFIX}:lock:{fingerprint}"
        lock_token = uuid.uuid4().hex
        acquired = await self._acquire_lock(lock_key, lock_token)
        if not acquired:
            cached = await self._wait_for_cached_object(cache_key)
            if cached:
                return self._with_staged_url(image, cached)

        try:
            cached = await self._get_cached_object(cache_key)
            if cached:
                return self._with_staged_url(image, cached)

            data, mime_type = await self._read_image(image, user_id)
            object_key = self._object_key(image, mime_type)
            await asyncio.to_thread(
                self._bucket().put_object,
                object_key,
                data,
                headers={"Content-Type": mime_type},
            )
            uploaded_at = int(time.time())
            cached = {
                "object_key": object_key,
                "uploaded_at": uploaded_at,
                "expires_at": (
                    uploaded_at + self._config.VIDEO_MODEL_IMAGE_OSS_CACHE_TTL_SECONDS
                ),
            }
            await self._cache.set(
                cache_key,
                cached,
                expire=self._config.VIDEO_MODEL_IMAGE_OSS_CACHE_TTL_SECONDS,
            )
            return self._with_staged_url(image, cached)
        finally:
            if acquired:
                await self._release_lock(lock_key, lock_token)

    async def _get_cached_object(self, cache_key: str) -> Optional[dict[str, Any]]:
        cached = await self._cache.get(cache_key)
        if not isinstance(cached, dict):
            return None

        expires_at = cached.get("expires_at")
        object_key = cached.get("object_key")
        if (
            not isinstance(expires_at, (int, float))
            or not isinstance(object_key, str)
            or expires_at - time.time() <= _MIN_REMAINING_SECONDS
        ):
            await self._cache.delete(cache_key)
            return None

        exists = await asyncio.to_thread(self._bucket().object_exists, object_key)
        if not exists:
            await self._cache.delete(cache_key)
            return None
        return cached

    async def _wait_for_cached_object(
        self,
        cache_key: str,
    ) -> Optional[dict[str, Any]]:
        deadline = time.monotonic() + _LOCK_WAIT_SECONDS
        while time.monotonic() < deadline:
            await asyncio.sleep(0.25)
            cached = await self._get_cached_object(cache_key)
            if cached:
                return cached
        return None

    async def _acquire_lock(self, key: str, token: str) -> bool:
        client = await self._cache._get_client()
        try:
            return bool(await client.set(key, token, ex=_LOCK_SECONDS, nx=True))
        except Exception:
            logger.warning("[VideoImageOSS] Redis lock unavailable", exc_info=True)
            return False
        finally:
            await client.aclose()

    async def _release_lock(self, key: str, token: str) -> None:
        client = await self._cache._get_client()
        try:
            await client.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then "
                "return redis.call('del', KEYS[1]) else return 0 end",
                1,
                key,
                token,
            )
        except Exception:
            logger.warning(
                "[VideoImageOSS] Failed to release Redis lock", exc_info=True
            )
        finally:
            await client.aclose()

    async def _read_image(
        self,
        image: dict[str, Any],
        user_id: int,
    ) -> tuple[bytes, str]:
        attachment_id = image.get("attachment_id")
        if isinstance(attachment_id, int):
            return await asyncio.to_thread(
                self._read_attachment,
                attachment_id,
                user_id,
            )

        url = str(image.get("url") or "")
        if url.startswith("data:"):
            return self._decode_data_url(url)
        if not url.startswith(("http://", "https://")):
            raise ValueError("Video reference image has no readable source")

        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
        data = response.content
        self._validate_size(data)
        mime_type = (
            str(image.get("mime_type") or "")
            or response.headers.get("content-type", "").split(";", 1)[0]
        )
        return data, self._validate_mime_type(mime_type)

    @staticmethod
    def _read_attachment(attachment_id: int, user_id: int) -> tuple[bytes, str]:
        from app.db.session import SessionLocal
        from app.models.subtask_context import SubtaskContext
        from app.services.context import context_service

        db = SessionLocal()
        try:
            attachment = (
                db.query(SubtaskContext)
                .filter(
                    SubtaskContext.id == attachment_id,
                    SubtaskContext.user_id == user_id,
                    SubtaskContext.context_type == "attachment",
                )
                .first()
            )
            if not attachment:
                raise ValueError(f"Reference attachment not found: {attachment_id}")
            data = context_service.get_attachment_binary_data(db, attachment)
            if data is None:
                raise ValueError(f"Reference attachment has no data: {attachment_id}")
            OssVideoImageStagingBackend._validate_size(data)
            return data, OssVideoImageStagingBackend._validate_mime_type(
                attachment.mime_type
            )
        finally:
            db.close()

    @staticmethod
    def _decode_data_url(url: str) -> tuple[bytes, str]:
        try:
            header, encoded = url.split(",", 1)
            mime_type = header.removeprefix("data:").split(";", 1)[0]
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Invalid video reference image data URL") from exc
        OssVideoImageStagingBackend._validate_size(data)
        return data, OssVideoImageStagingBackend._validate_mime_type(mime_type)

    @staticmethod
    def _validate_size(data: bytes) -> None:
        max_size = settings.MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024
        if len(data) > max_size:
            raise ValueError(
                "Video reference image exceeds maximum upload size "
                f"({settings.MAX_UPLOAD_FILE_SIZE_MB} MB)"
            )

    @staticmethod
    def _validate_mime_type(mime_type: str) -> str:
        normalized = mime_type.strip().lower()
        if not normalized.startswith("image/"):
            raise ValueError("Video reference material is not an image")
        return normalized

    def _with_staged_url(
        self,
        image: dict[str, Any],
        cached: dict[str, Any],
    ) -> dict[str, Any]:
        public_endpoint = self._config.VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT.strip()
        if not public_endpoint:
            raise ValueError(
                "VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT is required; signed OSS "
                "URLs cannot be sent to video providers"
            )
        object_path = quote(cached["object_key"], safe="/")
        return {
            **image,
            "url": f"{public_endpoint.rstrip('/')}/{object_path}",
        }

    def _bucket(self) -> Any:
        if self._bucket_override is not None:
            return self._bucket_override
        if self._bucket_instance is None:
            oss2 = _load_oss_sdk()
            auth = oss2.Auth(
                self._config.VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_ID,
                self._config.VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_SECRET,
            )
            self._bucket_instance = oss2.Bucket(
                auth,
                self._config.VIDEO_MODEL_IMAGE_OSS_ENDPOINT,
                self._config.VIDEO_MODEL_IMAGE_OSS_BUCKET,
            )
        return self._bucket_instance

    def _validate_config(self) -> None:
        required = {
            "VIDEO_MODEL_IMAGE_OSS_ENDPOINT": (
                self._config.VIDEO_MODEL_IMAGE_OSS_ENDPOINT
            ),
            "VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_ID": (
                self._config.VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_ID
            ),
            "VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_SECRET": (
                self._config.VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_SECRET
            ),
            "VIDEO_MODEL_IMAGE_OSS_BUCKET": (self._config.VIDEO_MODEL_IMAGE_OSS_BUCKET),
            "VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT": (
                self._config.VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT
            ),
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise ValueError(
                "Missing OSS video image staging configuration: " + ", ".join(missing)
            )

    def _object_key(
        self,
        image: dict[str, Any],
        mime_type: str,
    ) -> str:
        prefix = self._config.VIDEO_MODEL_IMAGE_OSS_PREFIX.strip("/")
        extension = str(image.get("file_extension") or "").lstrip(".")
        if not extension:
            extension = mimetypes.guess_extension(mime_type) or ".img"
            extension = extension.lstrip(".")
        return f"{prefix}/{uuid.uuid4().hex}/{uuid.uuid4().hex}.{extension}"

    @staticmethod
    def _fingerprint(image: dict[str, Any]) -> str:
        storage_key = str(image.get("storage_key") or "")
        if storage_key:
            identity = ":".join(
                [
                    str(image.get("storage_backend") or ""),
                    storage_key,
                    str(image.get("updated_at") or ""),
                ]
            )
        else:
            identity = str(image.get("url") or "")
        if not identity:
            raise ValueError("Video reference image has no stable identity")
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _load_oss_sdk() -> Any:
    try:
        import oss2
    except ImportError as exc:
        raise RuntimeError("Aliyun OSS staging requires the oss2 package") from exc
    return oss2


if video_image_staging_settings.VIDEO_MODEL_IMAGE_STAGING_BACKEND == "oss":
    register_video_image_staging_backend(
        OssVideoImageStagingBackend(video_image_staging_settings)
    )
    logger.info("[VideoImageOSS] Registered OSS staging backend")
