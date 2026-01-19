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

from app.services.memory.client import LongTermMemoryClient
from app.services.memory.manager import MemoryManager, get_memory_manager
from app.services.memory.utils import build_context_messages

__all__ = [
    "LongTermMemoryClient",
    "MemoryManager",
    "get_memory_manager",
    "build_context_messages",
]
