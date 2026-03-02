# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Video provider factory.
"""

from typing import Any, Dict

from .base import VideoProvider


def get_video_provider(protocol: str, model_config: Dict[str, Any]) -> VideoProvider:
    """
    Get video provider by protocol.

    Args:
        protocol: Provider protocol (e.g., 'seedance', 'runway', 'pika')
        model_config: Model configuration

    Returns:
        VideoProvider instance

    Raises:
        ValueError: If protocol is not supported
    """
    if protocol == "seedance":
        from .seedance import SeedanceProvider

        return SeedanceProvider(
            base_url=model_config.get("base_url"),
            api_key=model_config.get("api_key"),
            video_config=model_config.get("videoConfig", {}),
        )

    # Future providers
    # elif protocol == "runway":
    #     from .runway import RunwayProvider
    #     return RunwayProvider(...)
    # elif protocol == "pika":
    #     from .pika import PikaProvider
    #     return PikaProvider(...)

    raise ValueError(f"Unknown video provider: {protocol}")
