# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base class for video generation providers.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal, Optional


@dataclass
class VideoJobStatus:
    """Video job status."""

    progress: int  # 0-100
    is_completed: bool = False
    is_failed: bool = False
    error: Optional[str] = None


@dataclass
class VideoJobResult:
    """Video job result."""

    video_url: str
    thumbnail: Optional[str] = None  # Base64
    duration: Optional[float] = None
    image: Optional[str] = None  # For follow-up reference


class VideoProvider(ABC):
    """Base class for video generation providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name."""
        pass

    @abstractmethod
    async def create_job(
        self,
        prompt: str,
        reference_image: Optional[str] = None,
        image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None,
    ) -> str:
        """
        Create video generation job.

        Args:
            prompt: Video generation prompt
            reference_image: Optional reference image (base64)
            image_mode: How to use the reference image

        Returns:
            Job ID
        """
        pass

    @abstractmethod
    async def get_status(self, job_id: str) -> VideoJobStatus:
        """Get job status.

        Args:
            job_id: Job ID

        Returns:
            VideoJobStatus with progress and completion state
        """
        pass

    @abstractmethod
    async def get_result(self, job_id: str) -> VideoJobResult:
        """Get completed job result.

        Args:
            job_id: Job ID

        Returns:
            VideoJobResult with video URL and metadata
        """
        pass
