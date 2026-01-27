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

Default behavior:
- When backend has MEMORY_ENABLED=True (mem0 configured):
  - Users without explicit memory_enabled preference → memory is ON by default
  - Users with explicit memory_enabled=False → memory is OFF
- When backend has MEMORY_ENABLED=False (mem0 not configured):
  - Memory is always OFF regardless of user preference
"""

import json
import logging

from app.core.config import settings
from app.models.user import User
from app.services.memory.client import LongTermMemoryClient
from app.services.memory.manager import MemoryManager, get_memory_manager
from app.services.memory.utils import build_context_messages

logger = logging.getLogger(__name__)


def is_memory_enabled_for_user(user: User) -> bool:
    """Check if long-term memory is enabled for the given user.

    Default behavior:
    - When backend has MEMORY_ENABLED=True:
      - If user has NOT explicitly set memory_enabled preference → return True (default ON)
      - If user has explicitly set memory_enabled=False → return False
      - If user has explicitly set memory_enabled=True → return True
    - When backend has MEMORY_ENABLED=False:
      - Always return False (service not available)

    Args:
        user: User model instance

    Returns:
        True if memory should be enabled for this user, False otherwise
    """
    # First check if memory service is available at backend level
    if not settings.MEMORY_ENABLED:
        return False

    try:
        # Check if user has preferences
        if not user.preferences:
            # No preferences set → use default (True when service is available)
            return True

        # Parse preferences JSON string
        if isinstance(user.preferences, str):
            prefs = json.loads(user.preferences)
        elif isinstance(user.preferences, dict):
            prefs = user.preferences
        else:
            # Invalid preferences format → use default (True)
            return True

        # Check if memory_enabled is explicitly set
        # If not set (key doesn't exist), default to True when service is available
        # If explicitly set, use the user's preference
        if "memory_enabled" not in prefs:
            return True  # Default ON when service is available

        return prefs.get("memory_enabled", True)
    except (json.JSONDecodeError, AttributeError, TypeError) as e:
        logger.warning(
            "Failed to parse user preferences for memory check: %s", e, exc_info=True
        )
        # On parse error, default to True when service is available
        return True


__all__ = [
    "LongTermMemoryClient",
    "MemoryManager",
    "get_memory_manager",
    "build_context_messages",
    "is_memory_enabled_for_user",
]
