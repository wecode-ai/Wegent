# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utility functions for streaming module."""

from typing import Any


def truncate_list_keep_ends(items: list[Any], first_n: int, last_n: int) -> list[Any]:
    """Truncate a list keeping first N and last M items.

    Useful for chat history truncation to maintain context while limiting size.

    Args:
        items: List to truncate
        first_n: Number of items to keep from the start
        last_n: Number of items to keep from the end

    Returns:
        Truncated list, or original if len(items) <= first_n + last_n
    """
    if len(items) <= first_n + last_n:
        return items
    return items[:first_n] + items[-last_n:]
