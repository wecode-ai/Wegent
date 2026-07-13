"""Reusable internal Weibo image upload capability."""

import logging
from pathlib import PurePosixPath
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.services.tauth import auth_headers

logger = logging.getLogger(__name__)

WEIBO_IMAGE_UPLOAD_URL = "http://i.api.weibo.com/statuses/upload_pic.json"
WEIBO_IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
WEIBO_IMAGE_TIMEOUT_SECONDS = 15.0
WEIBO_IMAGE_SUPPORTED_MIME_TYPES = {"image/jpeg", "image/png", "image/gif"}


class WeiboImageUploadError(ValueError):
    """Raised when an image cannot be uploaded to Weibo image storage."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class WeiboImageUploadService:
    """Upload image bytes or URLs and return a reusable Weibo PID."""

    async def upload_bytes(
        self,
        *,
        filename: str,
        content: bytes,
        mime_type: str,
        uid: int,
    ) -> str:
        """Upload validated image bytes and return their PID."""
        self._validate_image(content, mime_type)
        headers = auth_headers(uid)
        async with httpx.AsyncClient(timeout=WEIBO_IMAGE_TIMEOUT_SECONDS) as client:
            response = await client.post(
                WEIBO_IMAGE_UPLOAD_URL,
                data={"print_mark": "0", "ori": "1"},
                files={"pic": (filename, content, mime_type)},
                headers=headers,
            )
        response.raise_for_status()
        pid = str((response.json() or {}).get("pic_id") or "").strip()
        if not pid:
            raise WeiboImageUploadError("upload_failed", "Image upload returned no PID")
        return pid

    async def upload_url(self, media_url: str, *, uid: int) -> str:
        """Stream an external image and upload it without buffering over 10 MB."""
        content, filename, mime_type = await self._download_image(media_url)
        return await self.upload_bytes(
            filename=filename,
            content=content,
            mime_type=mime_type,
            uid=uid,
        )

    @staticmethod
    def supports_mime_type(mime_type: str) -> bool:
        """Return whether the Weibo image endpoint supports this MIME type."""
        return mime_type in WEIBO_IMAGE_SUPPORTED_MIME_TYPES

    @staticmethod
    def _validate_image(content: bytes, mime_type: str) -> None:
        if mime_type not in WEIBO_IMAGE_SUPPORTED_MIME_TYPES:
            raise WeiboImageUploadError(
                "unsupported_media_type", "Only JPEG, PNG, and GIF are supported"
            )
        if len(content) >= WEIBO_IMAGE_MAX_UPLOAD_BYTES:
            raise WeiboImageUploadError(
                "image_too_large", "Image size must be less than 10 MB"
            )

    async def _download_image(self, media_url: str) -> tuple[bytes, str, str]:
        parsed_url = urlparse(media_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
            raise WeiboImageUploadError(
                "invalid_media_url", "media_url must be HTTP(S)"
            )
        async with httpx.AsyncClient(
            timeout=WEIBO_IMAGE_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as client:
            async with client.stream("GET", media_url) as response:
                response.raise_for_status()
                mime_type = response.headers.get("content-type", "").split(";", 1)[0]
                if mime_type not in WEIBO_IMAGE_SUPPORTED_MIME_TYPES:
                    raise WeiboImageUploadError(
                        "unsupported_media_type",
                        "Only JPEG, PNG, and GIF are supported",
                    )
                content_length = response.headers.get("content-length")
                if self._declared_size_exceeds_limit(content_length):
                    raise WeiboImageUploadError(
                        "image_too_large", "Image size must be less than 10 MB"
                    )
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) >= WEIBO_IMAGE_MAX_UPLOAD_BYTES:
                        raise WeiboImageUploadError(
                            "image_too_large", "Image size must be less than 10 MB"
                        )
                    content.extend(chunk)
        filename = PurePosixPath(parsed_url.path).name or "image.jpg"
        return bytes(content), filename, mime_type

    @staticmethod
    def _declared_size_exceeds_limit(content_length: Optional[str]) -> bool:
        if not content_length:
            return False
        try:
            return int(content_length) >= WEIBO_IMAGE_MAX_UPLOAD_BYTES
        except ValueError:
            return False


weibo_image_upload_service = WeiboImageUploadService()
