# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for handling legacy thinking tags in reasoning content."""

THINKING_OPEN_TAG = "<thinking>"
THINKING_CLOSE_TAG = "</thinking>"


def strip_legacy_thinking_tags(content: str) -> str:
    """Remove legacy thinking tags from reasoning content."""
    return content.replace(THINKING_OPEN_TAG, "").replace(THINKING_CLOSE_TAG, "")


def unwrap_thinking_content(content: str) -> str:
    """Remove thinking tags from content when storing internal reasoning."""
    if not content:
        return content
    return strip_legacy_thinking_tags(content)
