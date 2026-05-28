# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for exposing reasoning content with thinking tags."""

THINKING_OPEN_TAG = "<thinking>"
THINKING_CLOSE_TAG = "</thinking>"


def is_thinking_wrapped(content: str) -> bool:
    """Return whether content is already wrapped in thinking tags."""
    stripped = content.strip()
    return stripped.startswith(THINKING_OPEN_TAG) and stripped.endswith(
        THINKING_CLOSE_TAG
    )


def wrap_thinking_content(content: str) -> str:
    """Wrap reasoning content for external Responses API consumers."""
    if not content:
        return ""
    if is_thinking_wrapped(content):
        return content
    return f"{THINKING_OPEN_TAG}{content}{THINKING_CLOSE_TAG}"


def unwrap_thinking_content(content: str) -> str:
    """Remove thinking tags from content when storing internal reasoning."""
    if not content or not is_thinking_wrapped(content):
        return content

    stripped = content.strip()
    return stripped[len(THINKING_OPEN_TAG) : -len(THINKING_CLOSE_TAG)]
