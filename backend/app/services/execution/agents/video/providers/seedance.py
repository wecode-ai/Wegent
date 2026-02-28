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
        payload = {
            "prompt": prompt,
            "resolution": self.video_config.get("resolution", "1080p"),
            "fps": self.video_config.get("fps", 24),
        }

        if reference_image and image_mode:
            payload["reference_image"] = reference_image
            payload["image_mode"] = image_mode

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/v1/videos/generate",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            data = response.json()
            return data["id"]

    async def get_status(self, job_id: str) -> VideoJobStatus:
        """Get Seedance job status.

        Args:
            job_id: Job ID

        Returns:
            VideoJobStatus with progress and completion state
        """
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{self.base_url}/v1/videos/{job_id}/status",
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            response.raise_for_status()
            data = response.json()

            status = data.get("status", "processing")
            return VideoJobStatus(
                progress=data.get("progress", 0),
                is_completed=(status == "completed"),
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
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{self.base_url}/v1/videos/{job_id}/result",
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            response.raise_for_status()
            data = response.json()

            return VideoJobResult(
                video_url=data["video_url"],
                thumbnail=data.get("thumbnail"),
                duration=data.get("duration"),
                image=data.get("image"),  # For follow-up reference
            )
