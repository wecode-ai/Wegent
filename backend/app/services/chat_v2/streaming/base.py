# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Core streaming logic - re-exports from app.services.streaming.

This module is kept for backward compatibility. New code should import
directly from app.services.streaming.
"""

# Re-export everything from the centralized streaming module
from app.services.streaming.core import (
    StreamingConfig,
    StreamingCore,
    StreamingState,
    get_chat_semaphore,
)

# Also export truncate_list_keep_ends from utils
from app.services.streaming.utils import truncate_list_keep_ends

__all__ = [
    "StreamingCore",
    "StreamingConfig",
    "StreamingState",
    "get_chat_semaphore",
    "truncate_list_keep_ends",
]
