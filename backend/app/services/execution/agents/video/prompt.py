# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompt normalization for video generation requests."""

import re

from shared.prompts.constants import extract_user_question

_LEADING_ATTACHMENT_BLOCKS = re.compile(
    r"\A(?:\s*<attachment\b[^>]*>.*?</attachment>\s*)+",
    flags=re.IGNORECASE | re.DOTALL,
)


def normalize_video_prompt(prompt: str) -> str:
    """Return only user-authored text for a video provider request."""
    user_text = extract_user_question(prompt)
    return _LEADING_ATTACHMENT_BLOCKS.sub("", user_text).strip()
