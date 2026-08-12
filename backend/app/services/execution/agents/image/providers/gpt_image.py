# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GPT Image provider using the official OpenAI Images API over HTTP."""

import base64
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import unquote_to_bytes, urljoin

import httpx

from app.services.web_scraper.security import WebScraperUrlGuard

from .base import ImageGenerationResult, ImageProvider, ImageResult

logger = logging.getLogger(__name__)

GPT_IMAGE_GENERATIONS_PATH = "/images/generations"
GPT_IMAGE_EDITS_PATH = "/images/edits"
DEFAULT_TIMEOUT_SECONDS = 240.0
MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024
MAX_REFERENCE_REDIRECTS = 5


class GptImageProvider(ImageProvider):

    def __init__(
        self,
        base_url: Optional[str],
        api_key: str,
        model: Optional[str] = None,
        image_config: Optional[Dict[str, Any]] = None,
        default_headers: Optional[Dict[str, str]] = None,
    ):
        self.base_url = self._normalize_base_url(base_url)
        self.api_key = api_key or ""
        self.model = self._normalize_model(model)
        self.image_config = image_config or {}
        self.default_headers = dict(default_headers or {})
        self.timeout = httpx.Timeout(DEFAULT_TIMEOUT_SECONDS)

    @property
    def name(self) -> str:
        return "GPT Image"

    async def generate(
        self,
        prompt: str,
        reference_images: Optional[List[str]] = None,
        **kwargs,
    ) -> ImageGenerationResult:
        references = [
            reference.strip()
            for reference in reference_images or []
            if isinstance(reference, str) and reference.strip()
        ]
        payload = self._build_payload(prompt)
        path = GPT_IMAGE_GENERATIONS_PATH
        log_payload = dict(payload)
        if references:
            path = GPT_IMAGE_EDITS_PATH
            log_payload["image"] = references

        url = f"{self.base_url}{path}"
        logger.info(
            "[GptImageProvider] Sending request: url=%s, params=%s",
            url,
            self._request_log_params(log_payload),
        )

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            if references:
                files = await self._load_reference_files(client, references)
                response = await client.post(
                    url=url,
                    data=self._multipart_fields(payload),
                    files=files,
                    headers=self._request_headers(include_content_type=False),
                )
            else:
                response = await client.post(
                    url=url,
                    json=payload,
                    headers=self._request_headers(),
                )

        if response.status_code >= 400:
            raise RuntimeError(
                f"GPT image API error ({response.status_code}): "
                f"{self._extract_error(response)}"
            )

        data = response.json()
        if data.get("error"):
            raise RuntimeError(f"GPT image API error: {self._extract_error(response)}")

        size = payload.get("size") or data.get("size")
        images = [
            ImageResult(
                url=item.get("url"),
                b64_json=item.get("b64_json"),
                size=size,
            )
            for item in data.get("data") or []
            if isinstance(item, dict)
        ]
        return ImageGenerationResult(
            images=images,
            model=data.get("model") or self.model,
            usage=data.get("usage"),
        )

    def _build_payload(self, prompt: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "prompt": prompt,
            "n": self._image_count(),
        }
        for key in (
            "size",
            "quality",
            "output_format",
            "output_compression",
            "moderation",
        ):
            value = self.image_config.get(key)
            if value is not None and value != "":
                payload[key] = value

        background = self.image_config.get("background")
        if isinstance(background, str) and background:
            payload["background"] = background
        return payload

    def _image_count(self) -> int:
        try:
            count = int(self.image_config.get("max_images") or 1)
        except (TypeError, ValueError):
            return 1
        return max(1, min(count, 10))

    @staticmethod
    def _request_log_params(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Return request parameters without prompt or reference image contents."""
        safe_keys = (
            "model",
            "n",
            "size",
            "quality",
            "output_format",
            "output_compression",
            "moderation",
            "background",
        )
        params = {key: payload[key] for key in safe_keys if key in payload}
        references = payload.get("image")
        if references is not None:
            params["reference_image_count"] = (
                len(references) if isinstance(references, list) else 1
            )
        return params

    @staticmethod
    def _normalize_base_url(base_url: Optional[str]) -> str:
        normalized = (base_url or "").strip().rstrip("/")
        if not normalized:
            raise ValueError("GPT image provider requires base_url")
        return normalized

    @staticmethod
    def _normalize_model(model: Optional[str]) -> str:
        normalized = (model or "").strip()
        if not normalized:
            raise ValueError("GPT image provider requires model")
        return normalized

    def _request_headers(self, include_content_type: bool = True) -> Dict[str, str]:
        headers = dict(self.default_headers)
        if include_content_type:
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    @staticmethod
    def _multipart_fields(payload: Dict[str, Any]) -> Dict[str, str]:
        return {
            key: str(value).lower() if isinstance(value, bool) else str(value)
            for key, value in payload.items()
        }

    @classmethod
    async def _load_reference_files(
        cls,
        client: httpx.AsyncClient,
        references: List[str],
    ) -> List[tuple[str, tuple[str, bytes, str]]]:
        files: List[tuple[str, tuple[str, bytes, str]]] = []
        for index, reference in enumerate(references):
            content, mime_type = await cls._load_reference_image(client, reference)
            extension = cls._extension_for_mime_type(mime_type)
            files.append(
                (
                    "image[]",
                    (f"reference-{index + 1}.{extension}", content, mime_type),
                )
            )
        return files

    @classmethod
    async def _load_reference_image(
        cls,
        client: httpx.AsyncClient,
        reference: str,
    ) -> tuple[bytes, str]:
        if reference.startswith(("http://", "https://")):
            return await cls._load_remote_reference_image(client, reference)

        if reference.startswith("data:"):
            return cls._decode_data_url(reference)

        try:
            return base64.b64decode(reference, validate=True), "image/png"
        except ValueError as exc:
            raise ValueError(
                "Reference image must be a URL or base64 data URL"
            ) from exc

    @staticmethod
    async def _load_remote_reference_image(
        client: httpx.AsyncClient,
        reference: str,
    ) -> tuple[bytes, str]:
        guard = WebScraperUrlGuard()
        guard.validate_initial_url(reference)
        current_url = reference

        for _ in range(MAX_REFERENCE_REDIRECTS + 1):
            async with client.stream(
                "GET",
                current_url,
                follow_redirects=False,
            ) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("Reference image redirect is missing location")
                    current_url = urljoin(current_url, location)
                    guard.validate_final_url(reference, current_url)
                    continue

                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                mime_type = content_type.split(";", 1)[0].strip().lower()
                if not mime_type.startswith("image/"):
                    raise ValueError("Reference URL did not return an image")

                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except ValueError as exc:
                        raise ValueError(
                            "Reference image has an invalid Content-Length"
                        ) from exc
                    if declared_size > MAX_REFERENCE_IMAGE_BYTES:
                        raise ValueError("Reference image is too large")

                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > MAX_REFERENCE_IMAGE_BYTES:
                        raise ValueError("Reference image is too large")
                    content.extend(chunk)
                return bytes(content), mime_type

        raise ValueError("Reference image has too many redirects")

    @staticmethod
    def _decode_data_url(reference: str) -> tuple[bytes, str]:
        metadata, separator, encoded = reference.partition(",")
        if not separator:
            raise ValueError("Invalid reference image data URL")

        mime_type = metadata[5:].split(";", 1)[0] or "image/png"
        if ";base64" in metadata:
            return base64.b64decode(encoded), mime_type
        return unquote_to_bytes(encoded), mime_type

    @staticmethod
    def _extension_for_mime_type(mime_type: str) -> str:
        return {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
        }.get(mime_type.lower(), "png")

    @staticmethod
    def _extract_error(response: httpx.Response | Any) -> str:
        try:
            data = response.json()
        except Exception:
            return getattr(response, "text", "unknown error")

        error = data.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error)
        if error:
            return str(error)
        return getattr(response, "text", "unknown error")
