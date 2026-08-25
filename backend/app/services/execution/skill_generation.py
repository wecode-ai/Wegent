# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build the public generation context passed to generation Skills."""

from typing import Any

GENERATION_PARAMETER_KEYS = (
    "resolution",
    "ratio",
    "duration",
    "generation_mode_id",
    "size",
)


def build_skill_generation_context(
    generation: dict[str, Any],
) -> dict[str, Any]:
    """Convert request generation settings to the public Skill protocol."""
    model_name = str(generation.get("model") or "").strip()
    model_display_name = str(generation.get("model_display_name") or model_name).strip()
    content = [
        dict(item)
        for item in generation.get("content") or []
        if isinstance(item, dict) and item.get("type") != "generate_params"
    ]
    generate_params = {
        key: generation[key]
        for key in GENERATION_PARAMETER_KEYS
        if generation.get(key) is not None
    }
    if generate_params:
        content.append({"type": "generate_params", "value": generate_params})

    result: dict[str, Any] = {"content": content}
    if model_name:
        result["modelName"] = model_name
        result["modelDisplayName"] = model_display_name or model_name
    return result
