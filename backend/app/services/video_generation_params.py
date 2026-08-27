# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Validation for request-scoped video generation parameters."""

from collections.abc import Mapping
from typing import Any


def _get_param(params: Any, name: str) -> Any:
    if isinstance(params, Mapping):
        return params.get(name)
    return getattr(params, name, None)


def apply_video_generation_params(
    model_config: dict[str, Any],
    params: Any,
) -> None:
    """Validate and apply selected video parameters to a model config."""
    video_config = dict(model_config.get("videoConfig") or {})
    capabilities = video_config.get("capabilities") or {}

    resolution = _get_param(params, "resolution")
    if resolution:
        allowed_resolutions = [
            item.get("value") or item.get("label")
            for item in (capabilities.get("resolutions") or [])
        ]
        if allowed_resolutions and resolution not in allowed_resolutions:
            raise ValueError(
                f"Unsupported resolution '{resolution}', "
                f"allowed: {allowed_resolutions}"
            )
        video_config["resolution"] = resolution

    ratio = _get_param(params, "ratio")
    if ratio:
        allowed_ratios = [
            item.get("value") for item in (capabilities.get("aspect_ratios") or [])
        ]
        if allowed_ratios and ratio not in allowed_ratios:
            raise ValueError(
                f"Unsupported aspect ratio '{ratio}', allowed: {allowed_ratios}"
            )
        video_config["ratio"] = ratio

    duration = _get_param(params, "duration")
    if duration:
        allowed_durations = capabilities.get("durations_sec") or []
        if allowed_durations and duration not in allowed_durations:
            raise ValueError(
                f"Unsupported duration {duration}s, allowed: {allowed_durations}"
            )
        video_config["duration"] = duration

    model_config["videoConfig"] = video_config

    generation_mode_id = _get_param(params, "generation_mode_id")
    if generation_mode_id:
        allowed_mode_ids = [
            mode.get("id") for mode in (capabilities.get("generation_modes") or [])
        ]
        if allowed_mode_ids and generation_mode_id not in allowed_mode_ids:
            raise ValueError(
                f"Unsupported video generation mode '{generation_mode_id}'"
            )
        model_config["generation_mode_id"] = generation_mode_id
