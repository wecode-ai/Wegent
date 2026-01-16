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

        1. [2025-01-15] User prefers Python over JavaScript for backend tasks
        2. [2025-01-14] Project uses FastAPI framework with SQLAlchemy ORM

        Use this context to provide personalized responses.
        </memory>

        {original_system_prompt}
    """
    if not memories:
        return base_prompt

    # Build memory list
    memory_lines = []
    for idx, memory in enumerate(memories, start=1):
        # Extract created_at from metadata if available
        created_at = memory.metadata.get("created_at", "")
        if created_at and isinstance(created_at, str):
            try:
                # Format: YYYY-MM-DD
                dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                date_str = dt.strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                date_str = ""
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
    relevant_fields = ["task_id", "team_id", "group_id", "is_group_chat"]
    filtered = {k: v for k, v in metadata.items() if k in relevant_fields}
    return str(filtered)
