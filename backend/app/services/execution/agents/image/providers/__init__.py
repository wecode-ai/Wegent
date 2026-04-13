# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Image provider factory.
"""

from typing import Any, Dict

from .base import ImageProvider


def get_image_provider(protocol: str, model_config: Dict[str, Any]) -> ImageProvider:
    """
    Get image provider by protocol.

    Args:
        protocol: Provider protocol (e.g., 'seedream', 'openai')
        model_config: Model configuration

    Returns:
        ImageProvider instance

    Raises:
        ValueError: If the protocol is not supported
    """
    if protocol in ("seedream", "openai", "doubao"):
        # Seedream/Doubao uses OpenAI-compatible API format
        from .seedream import SeedreamProvider

        return SeedreamProvider(
            base_url=model_config.get("base_url"),
            api_key=model_config.get("api_key"),
            # Use model_id for the actual model name (e.g., "doubao-seedream-5-0-260128")
            # Note: "model" field contains the model type (e.g., "doubao"), not the model name
            model=model_config.get("model_id"),
            image_config=model_config.get("imageConfig", {}),
        )

    raise ValueError(f"Unknown image provider: {protocol}")


__all__ = ["get_image_provider", "ImageProvider"]
