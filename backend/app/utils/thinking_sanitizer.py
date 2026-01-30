# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utility functions for sanitizing thinking data before database storage.

This module provides functions to remove sensitive tool input/output data from
thinking steps before they are persisted to the database, in compliance with
the chat_shell TOOL_DISPLAY_WHITELIST configuration.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


def sanitize_thinking_for_storage(
    thinking: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Remove tool input/output from thinking steps before database storage.

    This function ensures that sensitive tool input/output data is not persisted
    to the database. It removes:
    - details.input field from tool_use steps
    - details.output field from tool_result steps
    - details.content field from tool_result steps

    Args:
        thinking: List of thinking steps containing tool execution data

    Returns:
        Sanitized list of thinking steps with input/output removed
    """
    if not thinking:
        return thinking

    sanitized = []
    for step in thinking:
        # Deep copy the step to avoid modifying the original
        step_copy = step.copy()

        # Process details if present
        if "details" in step_copy and isinstance(step_copy["details"], dict):
            details = step_copy["details"].copy()
            step_type = details.get("type")

            # Remove input from tool_use steps
            if step_type == "tool_use":
                details.pop("input", None)
                logger.debug(
                    "[SANITIZE] Removed input from tool_use: tool_name=%s",
                    details.get("tool_name", "unknown"),
                )

            # Remove output and content from tool_result steps
            elif step_type == "tool_result":
                details.pop("output", None)
                details.pop("content", None)
                logger.debug(
                    "[SANITIZE] Removed output from tool_result: tool_name=%s",
                    details.get("tool_name", "unknown"),
                )

            step_copy["details"] = details

        sanitized.append(step_copy)

    return sanitized


def sanitize_result_for_storage(result: dict[str, Any]) -> dict[str, Any]:
    """Sanitize entire result object before database storage.

    This function removes tool input/output from the result's thinking data
    while preserving all other fields like value, sources, reasoning_content, etc.

    Args:
        result: Result dictionary containing value, thinking, sources, etc.

    Returns:
        Sanitized result dictionary
    """
    if not result or not isinstance(result, dict):
        return result

    # Deep copy the result to avoid modifying the original
    result_copy = result.copy()

    # Sanitize thinking if present
    if "thinking" in result_copy and isinstance(result_copy["thinking"], list):
        result_copy["thinking"] = sanitize_thinking_for_storage(result_copy["thinking"])
        logger.info(
            "[SANITIZE] Sanitized thinking data: removed input/output from %d steps",
            len(result_copy["thinking"]),
        )

    return result_copy
