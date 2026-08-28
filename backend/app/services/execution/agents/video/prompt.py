# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompt normalization for video generation requests."""

from shared.prompts.constants import normalize_generation_prompt


def normalize_video_prompt(prompt: str) -> str:
    """Return only user-authored text for a video provider request."""
    return normalize_generation_prompt(prompt)
