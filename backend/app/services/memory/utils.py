# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utility functions for memory service."""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_sync,
)

from app.services.memory.schemas import MemorySearchResult

logger = logging.getLogger(__name__)


@trace_sync("memory.utils.inject_memories")
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
    # Set span attributes for observability
    set_span_attribute("memory.count", len(memories))

    if not memories:
        add_span_event("memory.inject.empty", {"reason": "no_memories_provided"})
        return base_prompt

    # Set memory IDs (truncated to first 5 for performance)
    memory_ids = [memory.id for memory in memories[:5]]
    set_span_attribute("memory.ids", ",".join(memory_ids))
    if len(memories) > 5:
        set_span_attribute("memory.ids_truncated", True)

    # Build memory list
    memory_lines = []
    parse_errors = 0
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
                parse_errors += 1
        else:
            date_str = ""

        # Format: N. [date] memory_content
        if date_str:
            memory_lines.append(f"{idx}. [{date_str}] {memory.memory}")
        else:
            memory_lines.append(f"{idx}. {memory.memory}")

    # Track date parsing errors if any occurred
    if parse_errors > 0:
        set_span_attribute("memory.date_parse_errors", parse_errors)
        add_span_event(
            "memory.date_parse_errors",
            {"error_count": parse_errors, "total_memories": len(memories)},
        )

    memory_block = (
        "<memory>\n"
        "The following are relevant memories from previous conversations:\n\n"
        + "\n".join(memory_lines)
        + "\n\nUse this context to provide personalized responses.\n"
        "</memory>\n\n"
    )

    # Set output attributes
    set_span_attribute("memory.block_length", len(memory_block))
    add_span_event(
        "memory.inject.success",
        {"memories_injected": len(memories), "block_length": len(memory_block)},
    )

    return memory_block + base_prompt


@trace_sync("memory.utils.format_metadata")
def format_metadata_for_logging(metadata: dict) -> str:
    """Format metadata dict for logging (redact sensitive fields).

    Args:
        metadata: Metadata dict

    Returns:
        Formatted string for logging
    """
    # Set span attributes
    set_span_attribute("metadata.field_count", len(metadata))

    # Keep only important fields for logging
    relevant_fields = ["task_id", "team_id", "project_id", "is_group_chat"]
    filtered = {k: v for k, v in metadata.items() if k in relevant_fields}

    # Track which fields were kept
    set_span_attribute("metadata.filtered_count", len(filtered))
    if filtered:
        set_span_attribute("metadata.filtered_fields", ",".join(filtered.keys()))

    return str(filtered)
