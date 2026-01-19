# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utility functions for memory service."""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_sync,
)
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
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

        1. [2025-01-15 14:30:45 CST] User prefers Python over JavaScript for backend tasks
        2. [2025-01-14 09:15:22 CST] Project uses FastAPI framework with SQLAlchemy ORM

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
        # Note: created_at is managed by mem0 (may use US/Pacific or UTC timezone)
        created_at = memory.created_at if hasattr(memory, "created_at") else None
        if created_at and isinstance(created_at, str):
            try:
                # Parse ISO format and convert to local timezone
                # Input: '2025-01-19T12:30:45.123456+00:00' or '2025-01-19T12:30:45Z'
                # mem0 uses US/Pacific timezone by default, but timestamps should have timezone info
                dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))

                # Convert to local timezone for display
                if dt.tzinfo is not None:
                    # Convert to local timezone
                    dt_local = dt.astimezone()
                else:
                    # If no timezone info, assume it's UTC and convert to local
                    dt_local = dt.replace(tzinfo=timezone.utc).astimezone()

                # Format with local timezone for clarity
                # Output: '2025-01-19 12:30:45 CST' or '2025-01-19 12:30:45 UTC+08:00'
                date_str = dt_local.strftime("%Y-%m-%d %H:%M:%S %Z")
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


@trace_sync("memory.utils.build_context_messages")
def build_context_messages(
    db: Session,
    existing_subtasks: List[Subtask],
    current_message: str,
    current_user: User,
    is_group_chat: bool,
    context_limit: int,
) -> List[Dict[str, str]]:
    """Build context messages for memory storage.

    Collects recent completed messages from history and adds the current message.
    For group chat, adds sender name prefix to user messages.

    Args:
        db: Database session
        existing_subtasks: List of existing subtasks (sorted by message_id desc)
        current_message: Current user message content
        current_user: Current user sending the message
        is_group_chat: Whether this is a group chat
        context_limit: Maximum number of messages to include (includes current message)

    Returns:
        List of message dicts with role and content, in chronological order

    Example:
        [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "user", "content": "How are you?"}
        ]

        For group chat:
        [
            {"role": "user", "content": "User[alice]: Hello"},
            {"role": "assistant", "content": "Hi Alice!"},
            {"role": "user", "content": "User[bob]: How are you?"}
        ]
    """
    # Set span attributes for observability
    set_span_attribute("context.limit", context_limit)
    set_span_attribute("context.is_group_chat", is_group_chat)
    set_span_attribute("context.existing_count", len(existing_subtasks))

    context_messages = []

    # Filter for completed USER and ASSISTANT messages only
    completed_subtasks = [
        st
        for st in existing_subtasks
        if st.status == SubtaskStatus.COMPLETED
        and st.role in (SubtaskRole.USER, SubtaskRole.ASSISTANT)
    ]

    # Get the last (context_limit - 1) completed messages as history
    history_count = min(context_limit - 1, len(completed_subtasks))
    set_span_attribute("context.history_count", history_count)

    for i in range(history_count):
        subtask = completed_subtasks[i]
        role = "user" if subtask.role == SubtaskRole.USER else "assistant"

        # Extract content based on role
        if subtask.role == SubtaskRole.USER:
            content = subtask.prompt or ""
        else:  # ASSISTANT
            content = ""
            if subtask.result and isinstance(subtask.result, dict):
                content = subtask.result.get("value", "")

        # Skip empty messages
        if not content:
            continue

        # For group chat user messages, add sender name prefix if not already present
        if role == "user" and is_group_chat:
            # Get sender user_name from user table
            sender = db.query(User).filter(User.id == subtask.sender_user_id).first()
            sender_name = (
                sender.user_name if sender else f"User{subtask.sender_user_id}"
            )
            # Add prefix if not already present
            if not content.startswith(f"User[{sender_name}]:"):
                content = f"User[{sender_name}]: {content}"

        context_messages.append({"role": role, "content": content})

    # Reverse to maintain chronological order (oldest to newest)
    context_messages.reverse()

    # Add current user message
    current_content = current_message
    if is_group_chat:
        # Add sender name prefix to current message
        sender_name = (
            current_user.user_name if current_user.user_name else str(current_user.id)
        )
        if not current_content.startswith(f"User[{sender_name}]:"):
            current_content = f"User[{sender_name}]: {current_content}"

    context_messages.append({"role": "user", "content": current_content})

    # Set output attributes
    set_span_attribute("context.output_count", len(context_messages))
    add_span_event(
        "context.build.success",
        {
            "history_messages": history_count,
            "output_messages": len(context_messages),
            "is_group_chat": is_group_chat,
        },
    )

    return context_messages
