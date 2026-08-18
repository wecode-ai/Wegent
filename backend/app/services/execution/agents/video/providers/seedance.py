# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Seedance video generation provider.
"""

import json
import logging
from typing import Any, Dict, Literal, Optional
from urllib.parse import parse_qsl, urlsplit

import httpx

from ..extensions import (
    VideoResultOverride,
    VideoStatusOverride,
    build_external_provider_content,
    parse_extended_result,
    parse_extended_status,
)
from .base import VideoJobResult, VideoJobStatus, VideoProvider
from .seedance_assets import (
    asset_library_enabled,
    prepare_seedance_reference_images,
)

logger = logging.getLogger(__name__)

_CREDENTIAL_QUERY_KEYS = {
    "access-token",
    "api-key",
    "signature",
    "security-token",
}
_CREDENTIAL_QUERY_KEY_SUFFIXES = (
    "credential",
    "securitytoken",
    "signature",
)
_SEEDANCE_25_MODEL_PREFIX = "doubao-seedance-2-5"
_OMNI_REFERENCE_TASK_TYPES = {"reference", "edit", "extend"}


def _is_credential_query_key(key: str) -> bool:
    """Return whether a query parameter name represents URL credentials."""
    normalized = key.strip().lower().replace("_", "-")
    compact = normalized.replace("-", "")
    return (
        normalized in _CREDENTIAL_QUERY_KEYS
        or compact.endswith(_CREDENTIAL_QUERY_KEY_SUFFIXES)
        or ("access" in compact and "key" in compact)
    )


def _resolve_capability_value(
    configured_value: Any,
    options: list[dict[str, Any]],
) -> Any:
    """Resolve a configured label to its provider-facing capability value."""
    for option in options:
        if configured_value in (option.get("value"), option.get("label")):
            return option.get("value") or option.get("label")
    return configured_value


def _is_seedance_25_model(model: Any) -> bool:
    """Return whether the configured model uses the Seedance 2.5 API contract."""
    return isinstance(model, str) and model.startswith(_SEEDANCE_25_MODEL_PREFIX)


def _seedance_25_task_type(generation_mode_id: Any) -> Optional[str]:
    """Map Wegent generation modes to Seedance 2.5 task guidance."""
    if generation_mode_id == "omni_reference":
        return "auto"
    if generation_mode_id in _OMNI_REFERENCE_TASK_TYPES:
        return str(generation_mode_id)
    return None


def _extract_api_error(response: httpx.Response) -> str:
    """Return the Seedance response body without friendly-message rewriting."""
    if response.text:
        return response.text
    try:
        return json.dumps(response.json(), ensure_ascii=False)
    except Exception:
        return "Unknown error"


def _media_url_for_log(item: dict[str, Any]) -> Optional[str]:
    """Return a signed-media URL without its credentials."""
    media = item.get(item.get("type"))
    if not isinstance(media, dict):
        return None
    url = media.get("url")
    if not isinstance(url, str):
        return None
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.netloc:
        return "<invalid-url>"
    safe_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    return f"{safe_url}?<redacted>" if parsed.query else safe_url


def _media_url_diagnostics(item: dict[str, Any]) -> dict[str, Any]:
    """Expose whether a provider URL unexpectedly contains credential parameters."""
    media = item.get(item.get("type"))
    if not isinstance(media, dict):
        return {}
    url = media.get("url")
    if not isinstance(url, str):
        return {}
    query_keys = [key for key, _ in parse_qsl(urlsplit(url).query)]
    credential_keys = [key for key in query_keys if _is_credential_query_key(key)]
    return {
        "has_query": bool(query_keys),
        "query_keys": query_keys,
        "credential_query_detected": bool(credential_keys),
        "credential_query_keys": credential_keys,
    }


def _reject_credential_media_urls(content: list[dict[str, Any]]) -> None:
    """Fail closed before a provider request can expose URL credentials."""
    credential_items = []
    for item in content:
        diagnostics = _media_url_diagnostics(item)
        if diagnostics.get("credential_query_detected"):
            credential_items.append(
                {
                    "type": item.get("type"),
                    "role": item.get("role"),
                    "url": _media_url_for_log(item),
                    "credential_query_keys": diagnostics["credential_query_keys"],
                }
            )
    if credential_items:
        logger.error(
            "[Seedance] Blocked credential-bearing media URLs: items=%s",
            credential_items,
        )
        raise ValueError(
            "Credential-bearing media URLs are not allowed in video provider "
            "requests; configure a public CDN endpoint"
        )


def _content_item_for_log(item: dict[str, Any]) -> dict[str, Any]:
    """Mirror request content while redacting signed URL credentials."""
    item_type = item.get("type")
    logged = {"type": item_type}
    if item.get("role") is not None:
        logged["role"] = item["role"]
    if item_type == "text":
        logged["text"] = item.get("text")
    elif media_url := _media_url_for_log(item):
        media_key = str(item_type)
        logged[media_key] = {"url": media_url}
        logged.update(_media_url_diagnostics(item))
    elif isinstance(item_type, str) and item_type in item:
        logged[item_type] = item[item_type]
    return logged


def _response_value_for_log(value: Any) -> Any:
    """Redact query strings from URLs in provider responses."""
    if isinstance(value, dict):
        return {key: _response_value_for_log(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_response_value_for_log(item) for item in value]
    if isinstance(value, str):
        parsed = urlsplit(value)
        if parsed.scheme and parsed.netloc and parsed.query:
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?<redacted>"
    return value


class SeedanceProvider(VideoProvider):
    """Seedance video generation provider."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        video_config: Optional[Dict[str, Any]] = None,
        default_headers: Optional[Dict[str, str]] = None,
    ):
        """Initialize Seedance provider.

        Args:
            base_url: Seedance API base URL
            api_key: API key for authentication
            video_config: Optional video configuration (resolution, fps, etc.)
        """
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.api_key = api_key or ""
        self.video_config = video_config or {}
        self.default_headers = dict(default_headers or {})

    def _request_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.default_headers,
        }

    @property
    def name(self) -> str:
        return "Seedance"

    async def create_job(
        self,
        prompt: str,
        reference_image: Optional[str] = None,
        image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None,
        reference_images: Optional[list] = None,
        reference_videos: Optional[list] = None,
        reference_audios: Optional[list] = None,
    ) -> str:
        """Create Seedance video generation job.

        Args:
            prompt: Video generation prompt
            reference_image: Optional reference image (base64)
            image_mode: How to use the reference image

        Returns:
            Job ID
        """
        wecode_user = next(
            (
                str(value)
                for key, value in self.default_headers.items()
                if key.lower() == "wecode-user" and value
            ),
            None,
        )
        if asset_library_enabled():
            async with httpx.AsyncClient(timeout=30.0) as asset_client:
                reference_images, reference_image = (
                    await prepare_seedance_reference_images(
                        client=asset_client,
                        reference_images=reference_images,
                        reference_image=reference_image,
                        wecode_user=wecode_user,
                    )
                )

        # Build content array
        content = [{"type": "text", "text": prompt}]

        images = reference_images or (
            [{"url": reference_image}] if reference_image else []
        )
        for index, image in enumerate(images):
            url = image.get("url") if isinstance(image, dict) else image
            if not url:
                continue
            role = "reference_image"
            if image_mode == "first_frame":
                if index == 0:
                    role = "first_frame"
                elif index == 1:
                    role = "last_frame"
            elif image_mode == "last_frame":
                role = "last_frame"
            content.append(
                {"type": "image_url", "image_url": {"url": url}, "role": role}
            )

        for video in reference_videos or []:
            descriptor = video if isinstance(video, dict) else {"url": video}
            external_content = build_external_provider_content(
                protocol="seedance",
                media_type="video",
                descriptor=descriptor,
                role="reference_video",
            )
            if external_content is not None:
                content.append(external_content)
                continue
            url = video.get("url") if isinstance(video, dict) else video
            if url:
                content.append(
                    {
                        "type": "video_url",
                        "video_url": {"url": url},
                        "role": "reference_video",
                    }
                )

        for audio in reference_audios or []:
            descriptor = audio if isinstance(audio, dict) else {"url": audio}
            external_content = build_external_provider_content(
                protocol="seedance",
                media_type="audio",
                descriptor=descriptor,
                role="reference_audio",
            )
            if external_content is not None:
                content.append(external_content)
                continue
            url = audio.get("url") if isinstance(audio, dict) else audio
            if url:
                content.append(
                    {
                        "type": "audio_url",
                        "audio_url": {"url": url},
                        "role": "reference_audio",
                    }
                )

        capabilities = self.video_config.get("capabilities") or {}
        model = self.video_config.get("model", "doubao-seedance-1-5-pro-251215")
        is_seedance_25 = _is_seedance_25_model(model)
        payload = {
            "model": model,
            "content": content,
            "resolution": _resolve_capability_value(
                self.video_config.get(
                    "resolution",
                    "720p" if is_seedance_25 else "480p",
                ),
                capabilities.get("resolutions") or [],
            ),
            "ratio": _resolve_capability_value(
                self.video_config.get(
                    "ratio",
                    "adaptive" if is_seedance_25 else "16:9",
                ),
                capabilities.get("aspect_ratios") or [],
            ),
            "duration": self.video_config.get(
                "duration",
                -1 if is_seedance_25 else 5,
            ),
            "watermark": self.video_config.get("watermark", False),
        }
        generate_audio = self.video_config.get("generate_audio")
        if generate_audio is None:
            generate_audio = (self.video_config.get("capabilities") or {}).get(
                "generate_audio"
            )
        if generate_audio is not None:
            payload["generate_audio"] = generate_audio

        if is_seedance_25:
            task_type = self.video_config.get(
                "omni_reference_task_type"
            ) or _seedance_25_task_type(self.video_config.get("generation_mode_id"))
            if task_type:
                payload["omni_reference_task_type"] = task_type
            for key in ("output_format", "priority"):
                if self.video_config.get(key) is not None:
                    payload[key] = self.video_config[key]
        elif image_mode:
            payload["image_mode"] = image_mode
        _reject_credential_media_urls(content)
        request_log_payload = {
            key: value for key, value in payload.items() if key != "content"
        }
        request_log_payload["content"] = [
            _content_item_for_log(item) for item in content
        ]
        logger.info(
            "[Seedance] Sending request: payload=%s, material_counts=%s",
            request_log_payload,
            {
                "images": len(images),
                "videos": len(reference_videos or []),
                "audios": len(reference_audios or []),
            },
        )
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/contents/generations/tasks",
                json=payload,
                headers=self._request_headers(),
            )
            if response.status_code >= 400:
                error_detail = _extract_api_error(response)
                raise Exception(
                    f"Seedance API error ({response.status_code}): {error_detail}"
                )
            data = response.json()
            job_id = data.get("id") if isinstance(data, dict) else None
            if not job_id:
                error_detail = (
                    _extract_api_error(response)
                    if isinstance(data, dict)
                    else "Invalid response"
                )
                raise Exception(f"Seedance API error: {error_detail}")
            return job_id

    async def _get_task(self, job_id: str, timeout: float = 10.0) -> Dict[str, Any]:
        """Get Seedance task details.

        Args:
            job_id: Job ID
            timeout: Request timeout in seconds

        Returns:
            Task data from API
        """
        url = f"{self.base_url}/contents/generations/tasks/{job_id}"
        logger.info(f"[Seedance] Getting task: job_id={job_id}, url={url}")

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                url,
                headers=self._request_headers(),
            )
            if response.status_code >= 400:
                error_detail = _extract_api_error(response)
                raise Exception(
                    f"Seedance API error ({response.status_code}): {error_detail}"
                )
            data = response.json()

            logger.info(
                f"[Seedance] Task response: job_id={job_id}, "
                f"status={data.get('status')}, data={_response_value_for_log(data)}"
            )
            return data

    async def get_status(self, job_id: str) -> VideoJobStatus:
        """Get Seedance job status.

        Args:
            job_id: Job ID

        Returns:
            VideoJobStatus with progress and completion state
        """
        data = await self._get_task(job_id)

        # Status values: queued, running, succeeded, failed
        status = data.get("status", "running")
        api_progress = data.get("progress", 0)

        parsed = parse_extended_status(
            data,
            VideoStatusOverride(
                progress=api_progress,
                is_completed=(status == "succeeded"),
                is_failed=(status == "failed"),
                error=data.get("error"),
            ),
        )
        return VideoJobStatus(
            progress=parsed.progress,
            is_completed=parsed.is_completed,
            is_failed=parsed.is_failed,
            error=parsed.error,
        )

    async def get_result(self, job_id: str) -> VideoJobResult:
        """Get Seedance job result.

        Args:
            job_id: Job ID

        Returns:
            VideoJobResult with video URL and metadata
        """
        data = await self._get_task(job_id, timeout=30.0)

        # Video URL is in content.video_url
        content = data.get("content", {})
        parsed = parse_extended_result(
            data,
            VideoResultOverride(
                video_url=content.get("video_url", ""),
                thumbnail=None,
                duration=data.get("duration"),
            ),
        )
        return VideoJobResult(
            video_url=parsed.video_url or "",
            thumbnail=parsed.thumbnail,
            duration=parsed.duration,
            image=None,
            metadata=parsed.metadata,
        )
