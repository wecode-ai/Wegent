# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utility functions for memory service."""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.services.memory.schemas import MemorySearchResult

logger = logging.getLogger(__name__)


def inject_memories_to_prompt(
    base_prompt: str, memories: List[MemorySearchResult]
) -> str:
    """Inject memory context into system prompt.

    Adds a <memory> block at the beginning of the system prompt containing
    relevant memories from previous conversations.

    Args:
        base_prompt: Original system prompt
        memories: List of relevant memories to inject

    Returns:
        Enhanced system prompt with memory context

    Example:
        <memory>
        The following are relevant memories from previous conversations:

        1. [2025-01-15 14:30:45] User prefers Python over JavaScript for backend tasks
        2. [2025-01-14 09:15:22] Project uses FastAPI framework with SQLAlchemy ORM

        Use this context to provide personalized responses.
        </memory>

        {original_system_prompt}
    """
    if not memories:
        return base_prompt

    # Build memory list
    memory_lines = []
    for idx, memory in enumerate(memories, start=1):
        # Extract created_at from top-level memory object (mem0 reserved field)
        # Note: created_at is managed by mem0 and uses US/Pacific timezone
        created_at = memory.created_at if hasattr(memory, "created_at") else None
        if created_at and isinstance(created_at, str):
            try:
                # Parse ISO format and format for readability
                # Input: '2025-01-19T12:30:45.123456+00:00' or '2025-01-19T12:30:45Z'
                # Output: '2025-01-19 12:30:45' (drop microseconds and timezone for cleaner display)
                dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                date_str = dt.strftime("%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError):
                # If parsing fails, use original string (better than empty)
                date_str = created_at
        else:
            date_str = ""

        # Format: N. [date] memory_content
        if date_str:
            memory_lines.append(f"{idx}. [{date_str}] {memory.memory}")
        else:
            memory_lines.append(f"{idx}. {memory.memory}")

    memory_block = (
        "<memory>\n"
        "The following are relevant memories from previous conversations:\n\n"
        + "\n".join(memory_lines)
        + "\n\nUse this context to provide personalized responses.\n"
        "</memory>\n\n"
    )

    return memory_block + base_prompt


def format_metadata_for_logging(metadata: dict) -> str:
    """Format metadata dict for logging (redact sensitive fields).

    Args:
        metadata: Metadata dict

    Returns:
        Formatted string for logging
    """
    # Keep only important fields for logging
    relevant_fields = ["task_id", "team_id", "project_id", "is_group_chat"]
    filtered = {k: v for k, v in metadata.items() if k in relevant_fields}
    return str(filtered)
