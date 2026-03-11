# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base class for image generation providers.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class ImageResult:
    """Single image result."""

    url: Optional[str] = None  # Image URL (when response_format='url')
    b64_json: Optional[str] = None  # Base64 encoded (when response_format='b64_json')
    size: Optional[str] = None  # Image dimensions (e.g., '2048x2048')


@dataclass
class ImageGenerationResult:
    """Image generation result."""

    images: List[ImageResult] = field(default_factory=list)
    model: str = ""
    usage: Optional[Dict] = None


class ImageProvider(ABC):
    """Base class for image generation providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name."""
        pass

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        reference_images: Optional[List[str]] = None,
        **kwargs,
    ) -> ImageGenerationResult:
        """
        Generate images.

        Args:
            prompt: Text prompt for image generation
            reference_images: Optional list of reference images (URL or base64)
            **kwargs: Additional provider-specific parameters

        Returns:
            ImageGenerationResult with generated images
        """
        pass
