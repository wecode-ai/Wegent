# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wanxiang-compatible provider with HappyHorse request semantics."""

from typing import Any, Dict, Literal, Optional

import httpx

from ..extensions import (
    VideoResultOverride,
    VideoStatusOverride,
    parse_extended_result,
    parse_extended_status,
)
from .base import VideoJobResult, VideoJobStatus, VideoProvider


def _extract_api_error(response: httpx.Response) -> str:
    """Return a compact provider error without exposing request credentials."""
    try:
        payload = response.json()
    except ValueError:
        return (response.text or "Unknown error")[:200]
    if isinstance(payload, dict):
        for key in ("error", "message", "detail", "msg"):
            if key in payload:
                return str(payload[key])
    return str(payload)


def _media_value(descriptor: Any, id_key: str) -> Optional[str]:
    if isinstance(descriptor, str):
        return descriptor.strip() or None
    if not isinstance(descriptor, dict):
        return None
    for key in (id_key, "url"):
        value = descriptor.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


class WanxiangProvider(VideoProvider):
    """Generate HappyHorse video tasks through the Wanxiang protocol."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model_id: Optional[str] = None,
        video_config: Optional[Dict[str, Any]] = None,
        default_headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.api_key = api_key or ""
        self.model_id = model_id or "happyhorse-1.0"
        self.video_config = video_config or {}
        self.default_headers = dict(default_headers or {})

    @property
    def name(self) -> str:
        return "Wanxiang"

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.default_headers,
        }

    def _build_happyhorse_payload(
        self,
        prompt: str,
        reference_image: Optional[str],
        reference_images: Optional[list],
        reference_videos: Optional[list],
    ) -> Dict[str, Any]:
        images = [
            value
            for item in (reference_images or [])
            if (value := _media_value(item, "pic_id"))
        ]
        if reference_image and not images:
            images.append(reference_image)
        videos = [
            value
            for item in (reference_videos or [])
            if (value := _media_value(item, "media_id"))
        ]

        if videos:
            if len(videos) != 1:
                raise ValueError("HappyHorse supports exactly one reference video")
            if len(images) > 5:
                raise ValueError("HappyHorse video edit supports at most 5 images")
            variant = "video-edit"
        elif images:
            if len(images) > 9:
                raise ValueError("HappyHorse reference mode supports at most 9 images")
            variant = "r2v"
        else:
            variant = "t2v"

        input_payload: Dict[str, Any] = {"prompt": prompt.strip()}
        if not input_payload["prompt"]:
            raise ValueError("Prompt is required for HappyHorse video generation")
        if variant == "r2v":
            input_payload["media"] = [
                {"type": "reference_image", "url": value} for value in images
            ]
        elif variant == "video-edit":
            input_payload["media"] = [
                {"type": "video", "url": videos[0]},
                *[{"type": "reference_image", "url": value} for value in images],
            ]

        parameters: Dict[str, Any] = {
            "resolution": str(self.video_config.get("resolution") or "1080p").upper(),
            "watermark": bool(self.video_config.get("watermark", False)),
        }
        if variant != "video-edit":
            parameters["duration"] = self.video_config.get("duration", 5)
            parameters["ratio"] = self.video_config.get("ratio") or "16:9"
        return {
            "model": f"happyhorse-1.0-{variant}",
            "input": input_payload,
            "parameters": parameters,
        }

    async def create_job(
        self,
        prompt: str,
        reference_image: Optional[str] = None,
        image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None,
        reference_images: Optional[list] = None,
        reference_videos: Optional[list] = None,
        reference_audios: Optional[list] = None,
    ) -> str:
        del image_mode
        if reference_audios:
            raise ValueError("HappyHorse does not support reference audio")
        payload = self._build_happyhorse_payload(
            prompt,
            reference_image,
            reference_images,
            reference_videos,
        )
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/contents/generations/tasks",
                json=payload,
                headers=self._headers(),
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Wanxiang API error ({response.status_code}): "
                f"{_extract_api_error(response)}"
            )
        data = response.json()
        output = data.get("output", {}) if isinstance(data, dict) else {}
        job_id = output.get("task_id") or data.get("task_id")
        if not job_id:
            raise RuntimeError(f"Wanxiang API error: {_extract_api_error(response)}")
        return str(job_id)

    async def _get_task(self, job_id: str, timeout: float = 10.0) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                f"{self.base_url}/contents/generations/tasks/{job_id}",
                headers=self._headers(),
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Wanxiang API error ({response.status_code}): "
                f"{_extract_api_error(response)}"
            )
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("Wanxiang API returned an invalid response")
        return data

    async def get_status(self, job_id: str) -> VideoJobStatus:
        data = await self._get_task(job_id)
        output = data.get("output", {})
        status = str(output.get("task_status") or data.get("status") or "RUNNING")
        normalized = status.upper()
        parsed = parse_extended_status(
            data,
            VideoStatusOverride(
                progress=int(output.get("progress") or data.get("progress") or 0),
                is_completed=normalized in {"SUCCEEDED", "SUCCESS"},
                is_failed=normalized in {"FAILED", "FAILURE"},
                error=output.get("message") or output.get("error"),
            ),
        )
        return VideoJobStatus(
            progress=parsed.progress,
            is_completed=parsed.is_completed,
            is_failed=parsed.is_failed,
            error=parsed.error,
        )

    async def get_result(self, job_id: str) -> VideoJobResult:
        data = await self._get_task(job_id, timeout=30.0)
        output = data.get("output", {})
        parsed = parse_extended_result(
            data,
            VideoResultOverride(video_url=output.get("video_url", "")),
        )
        return VideoJobResult(
            video_url=parsed.video_url or "",
            thumbnail=parsed.thumbnail,
            duration=parsed.duration,
            metadata=parsed.metadata,
        )
