# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generation-related schemas for video and image generation models.

This module contains configuration schemas for:
- Video generation (VideoGenerationConfig)
- Image generation (ImageGenerationConfig)
"""

from typing import Optional

from pydantic import BaseModel, Field


class VideoGenerationConfig(BaseModel):
    """Video generation specific configuration"""

    resolution: Optional[str] = Field("1080p", description="Video resolution")
    fps: Optional[int] = Field(24, description="Frames per second")
    max_duration: Optional[int] = Field(None, description="Maximum duration in seconds")


class ImageGenerationConfig(BaseModel):
    """Image generation specific configuration"""

    # Size configuration
    size: Optional[str] = Field(
        "2048x2048",
        description="Image size. Can be resolution like '2K'/'3K' or pixel dimensions like '2048x2048'",
    )

    # Sequential image generation configuration
    sequential_image_generation: Optional[str] = Field(
        "disabled",
        description="Sequential image generation mode: 'auto' for multi-image, 'disabled' for single image",
    )
    max_images: Optional[int] = Field(
        1,
        ge=1,
        le=15,
        description="Maximum number of images to generate (only when sequential_image_generation='auto')",
    )

    # Output configuration
    response_format: Optional[str] = Field(
        "url",
        description="Response format: 'url' for image URL, 'b64_json' for base64 encoded",
    )
    output_format: Optional[str] = Field(
        "jpeg",
        description="Output image format: 'jpeg' or 'png' (only for seedream-5.0-lite)",
    )

    # Other configuration
    watermark: Optional[bool] = Field(
        False,
        description="Whether to add watermark to generated images",
    )
    optimize_prompt_mode: Optional[str] = Field(
        "standard",
        description="Prompt optimization mode: 'standard' or 'fast'",
    )
