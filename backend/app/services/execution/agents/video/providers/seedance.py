# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Seedance video generation provider.
"""

import logging
from typing import Any, Dict, Literal, Optional

import httpx

from .base import VideoJobResult, VideoJobStatus, VideoProvider

logger = logging.getLogger(__name__)


def _resolve_capability_value(
    configured_value: Any,
    options: list[dict[str, Any]],
) -> Any:
    """Resolve a configured label to its provider-facing capability value."""
    for option in options:
        if configured_value in (option.get("value"), option.get("label")):
            return option.get("value") or option.get("label")
    return configured_value


def _extract_api_error(response: httpx.Response) -> str:
    """Extract a user-friendly error message from an API response without exposing internal URLs."""
    try:
        data = response.json()
        # Try common error response formats
        if isinstance(data, dict):
            for key in ("error", "message", "detail", "msg"):
                if key in data:
                    err = data[key]
                    if isinstance(err, dict) and "message" in err:
                        return err["message"]
                    return str(err)
        return str(data)
    except Exception:
        text = response.text[:200] if response.text else "Unknown error"
        return text


class SeedanceProvider(VideoProvider):
    """Seedance 1.5 video generation provider."""

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
        payload = {
            "model": self.video_config.get("model", "doubao-seedance-1-5-pro-251215"),
            "content": content,
            "resolution": _resolve_capability_value(
                self.video_config.get("resolution", "480p"),
                capabilities.get("resolutions") or [],
            ),
            "ratio": _resolve_capability_value(
                self.video_config.get("ratio", "16:9"),
                capabilities.get("aspect_ratios") or [],
            ),
            "duration": self.video_config.get("duration", 5),
            "watermark": self.video_config.get("watermark", False),
        }
        generate_audio = self.video_config.get("generate_audio")
        if generate_audio is None:
            generate_audio = (self.video_config.get("capabilities") or {}).get(
                "generate_audio"
            )
        if generate_audio is not None:
            payload["generate_audio"] = generate_audio

        if image_mode:
            payload["image_mode"] = image_mode
        request_log_params = {
            key: value for key, value in payload.items() if key != "content"
        }
        request_log_params["content"] = [
            {
                "type": item.get("type"),
                "role": item.get("role"),
            }
            for item in content
        ]
        request_log_params.update(
            {
                "reference_image_count": len(images),
                "reference_video_count": len(reference_videos or []),
                "reference_audio_count": len(reference_audios or []),
                "prompt_preview": prompt.replace("\n", " ")[:500],
            }
        )
        logger.info("[Seedance] Sending request:,params=%s", request_log_params)
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
                f"status={data.get('status')}, data={data}"
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

        return VideoJobStatus(
            progress=api_progress,
            is_completed=(status == "succeeded"),
            is_failed=(status == "failed"),
            error=data.get("error"),
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
        return VideoJobResult(
            video_url=content.get("video_url", ""),
            thumbnail=None,
            duration=data.get("duration"),
            image=None,
        )
