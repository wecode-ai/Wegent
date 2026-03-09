# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Seedream image generation provider.

Seedream is a text-to-image model from Volcano Engine (ByteDance).
It supports:
- Text-to-image generation
- Image-to-image generation (with reference images)
- Sequential image generation (multiple images)
"""

import logging
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

from .base import ImageGenerationResult, ImageProvider, ImageResult

logger = logging.getLogger(__name__)


class SeedreamProvider(ImageProvider):
    """Seedream image generation provider."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: Optional[str] = None,
        image_config: Optional[Dict[str, Any]] = None,
    ):
        """Initialize Seedream provider.

        Args:
            base_url: Seedream API base URL
            api_key: API key for authentication
            model: Model name (e.g., 'doubao-seedream-5-0-260128')
            image_config: Optional image configuration
        """
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.api_key = api_key or ""
        # Default model name follows the official format: doubao-seedream-5-0-260128
        # Note: Use hyphens (-) not dots (.) in the model name
        self.model = model or ""
        self.image_config = image_config or {}
        self.client = AsyncOpenAI(
            base_url=f"{self.base_url}" if self.base_url else None,
            api_key=self.api_key,
        )

    @property
    def name(self) -> str:
        return "Seedream"

    async def generate(
        self,
        prompt: str,
        reference_images: Optional[List[str]] = None,
        **kwargs,
    ) -> ImageGenerationResult:
        """Generate images using Seedream API.

        Args:
            prompt: Text prompt
            reference_images: Optional reference images
            **kwargs: Additional parameters

        Returns:
            ImageGenerationResult
        """
        size = self.image_config.get("size", "2048x2048")
        response_format = self.image_config.get("response_format", "url")

        # Build extra_body for Seedream-specific parameters
        extra_body: Dict[str, Any] = {
            "watermark": self.image_config.get("watermark", False),
        }

        # Add reference images if provided.
        # Note: doubao-seedream-3.0-t2i does NOT support the image parameter.
        # Other Seedream variants (5.0-lite, 4.5, 4.0, seededit-3.0-i2i) support it.
        model_supports_reference_image = not any(
            tag in self.model for tag in ("3.0-t2i", "3-0-t2i")
        )
        if reference_images and model_supports_reference_image:
            if len(reference_images) == 1:
                extra_body["image"] = reference_images[0]
            else:
                extra_body["image"] = reference_images

        # Add sequential image generation config
        seq_mode = self.image_config.get("sequential_image_generation", "disabled")
        extra_body["sequential_image_generation"] = seq_mode
        if seq_mode == "auto":
            max_images = self.image_config.get("max_images", 1)
            if max_images > 1:
                extra_body["sequential_image_generation_options"] = {
                    "max_images": max_images
                }

        # Add output format for seedream-5.0-lite
        output_format = self.image_config.get("output_format")
        if output_format:
            extra_body["output_format"] = output_format

        # Add prompt optimization mode
        optimize_mode = self.image_config.get("optimize_prompt_mode")
        if optimize_mode:
            extra_body["optimize_prompt_options"] = {"mode": optimize_mode}

        logger.info(
            f"[SeedreamProvider] Generating image: model={self.model}, size={size}"
        )

        response = await self.client.images.generate(
            model=self.model,
            prompt=prompt,
            size=size,
            response_format=response_format,
            extra_body=extra_body,
        )

        # Parse response
        images = []
        for item in response.data:
            images.append(
                ImageResult(
                    url=item.url,
                    b64_json=item.b64_json,
                    size=size,
                )
            )

        return ImageGenerationResult(
            images=images,
            model=response.model or self.model,
            usage=None,  # OpenAI images.generate response doesn't include usage
        )
