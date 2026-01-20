# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Long-term memory service for Wegent.

This module provides integration with mem0 service for persistent memory
across conversations. It supports:
- Storing user messages as memories
- Retrieving relevant memories based on query
- Deleting memories when tasks are deleted

Design principles:
- Minimal invasiveness (no database schema changes)
- Graceful degradation (service unavailable → continue normally)
- Async-first (fire-and-forget writes, timeout reads)
- Future-proof for conversation groups
"""

import json
import logging

from app.models.user import User
from app.services.memory.client import LongTermMemoryClient
from app.services.memory.manager import MemoryManager, get_memory_manager
from app.services.memory.utils import build_context_messages

logger = logging.getLogger(__name__)


def is_memory_enabled_for_user(user: User) -> bool:
    """Check if long-term memory is enabled for the given user.

    Args:
        user: User model instance

    Returns:
        True if memory is enabled in user preferences, False otherwise
    """
    try:
        # Check if user has preferences
        if not user.preferences:
            return False

        # Parse preferences JSON string
        if isinstance(user.preferences, str):
            prefs = json.loads(user.preferences)
        elif isinstance(user.preferences, dict):
            prefs = user.preferences
        else:
            return False

        # Check memory_enabled field (default: False for new feature)
        return prefs.get("memory_enabled", False)
    except (json.JSONDecodeError, AttributeError, TypeError) as e:
        logger.warning(
            "Failed to parse user preferences for memory check: %s", e, exc_info=True
        )
        return False


__all__ = [
    "LongTermMemoryClient",
    "MemoryManager",
    "get_memory_manager",
    "build_context_messages",
    "is_memory_enabled_for_user",
]
