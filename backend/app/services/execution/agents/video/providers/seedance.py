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
from .progress_simulator import ProgressSimulator

logger = logging.getLogger(__name__)


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
        # Use progress simulator for simulated progress when API returns 0
        self._progress_simulator = ProgressSimulator()

    @property
    def name(self) -> str:
        return "Seedance"

    async def create_job(
        self,
        prompt: str,
        reference_image: Optional[str] = None,
        image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None,
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

        if reference_image and image_mode:
            content.append({"type": "image_url", "image_url": {"url": reference_image}})

        payload = {
            "model": self.video_config.get("model", "doubao-seedance-1-5-pro-251215"),
            "content": content,
            "resolution": self.video_config.get("resolution", "480p"),
            "ratio": self.video_config.get("ratio", "16:9"),
            "duration": self.video_config.get("duration", 5),
            "watermark": self.video_config.get("watermark", False),
        }

        if image_mode:
            payload["image_mode"] = image_mode
        logger.info(f"[Seedance] Creating job with payload: {payload}")
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/contents/generations/tasks",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
            if response.status_code >= 400:
                error_detail = _extract_api_error(response)
                raise Exception(
                    f"Seedance API error ({response.status_code}): {error_detail}"
                )
            data = response.json()
            job_id = data["id"]
            # Start tracking job for simulated progress
            self._progress_simulator.start_job(job_id)
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
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
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
        is_running = status in ("queued", "running")

        # Get progress (simulated if API returns 0)
        progress = self._progress_simulator.get_progress(
            job_id, api_progress, is_running
        )

        # Clean up job tracking when completed or failed
        if not is_running:
            self._progress_simulator.end_job(job_id)

        return VideoJobStatus(
            progress=progress,
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
