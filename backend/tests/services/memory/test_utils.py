# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for memory utility functions."""

import re
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.memory.schemas import MemorySearchResult
from app.services.memory.utils import build_context_messages, inject_memories_to_prompt


def test_inject_memories_to_prompt_with_dates():
    """Test injecting memories with timestamps in local timezone."""
    memories = [
        MemorySearchResult(
            id="mem-1",
            memory="User prefers Python over JavaScript",
            metadata={},
            created_at="2025-01-15T10:30:00Z",
        ),
        MemorySearchResult(
            id="mem-2",
            memory="Project uses FastAPI framework",
            metadata={},
            created_at="2025-01-14T15:20:00Z",
        ),
    ]

    base_prompt = "You are a helpful coding assistant."
    result = inject_memories_to_prompt(base_prompt, memories)

    # Check structure
    assert result.startswith("<memory>")
    assert "relevant memories from previous conversations" in result
    assert "</memory>" in result
    assert base_prompt in result

    # Check content with local timezone format (includes date and timezone suffix)
    # Pattern: [YYYY-MM-DD HH:MM:SS TZ] where TZ can be CST, UTC, PST, UTC+08:00, etc.
    datetime_pattern = r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [^\]]+)?\]"
    matches = re.findall(datetime_pattern, result)
    assert len(matches) == 2, f"Expected 2 timestamps, found {len(matches)}: {matches}"

    # Check memory content is present
    assert "User prefers Python over JavaScript" in result
    assert "Project uses FastAPI framework" in result

    # Check ordering
    assert result.index("1.") < result.index("2.")
    assert result.index("</memory>") < result.index(base_prompt)


def test_inject_memories_to_prompt_without_dates():
    """Test injecting memories without timestamps."""
    memories = [
        MemorySearchResult(id="mem-1", memory="User likes clean code", metadata={}),
        MemorySearchResult(
            id="mem-2", memory="Prefers type hints", metadata={}, created_at=None
        ),
    ]

    base_prompt = "You are an assistant."
    result = inject_memories_to_prompt(base_prompt, memories)

    # Check that memories are included without dates
    assert "User likes clean code" in result
    assert "Prefers type hints" in result

    # Should not have datetime-bracket patterns like [YYYY-MM-DD HH:MM:SS TZ]
    datetime_pattern = r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( [A-Z]{3,4})?\]"
    assert not re.search(
        datetime_pattern, result
    ), "Should not contain datetime brackets when created_at is missing"

    # Verify <memory> tags are present
    assert result.count("<memory>") == 1
    assert result.count("</memory>") == 1


def test_inject_memories_to_prompt_empty():
    """Test injecting empty memory list."""
    memories = []
    base_prompt = "You are a helpful assistant."

    result = inject_memories_to_prompt(base_prompt, memories)

    # Should return unchanged prompt
    assert result == base_prompt
    assert "<memory>" not in result


def test_inject_memories_to_prompt_invalid_date():
    """Test handling of invalid date format."""
    memories = [
        MemorySearchResult(
            id="mem-1",
            memory="Test memory",
            metadata={},
            created_at="invalid-date-format",
        )
    ]

    base_prompt = "You are an assistant."
    result = inject_memories_to_prompt(base_prompt, memories)

    # Should still include the memory, just without formatted date
    assert "Test memory" in result
    assert "<memory>" in result


def test_build_context_messages_basic():
    """Test building context messages with basic history."""
    # Mock database session
    db = MagicMock()

    # Create mock user
    current_user = User(id=1, user_name="alice")

    # Create mock subtasks (existing history)
    existing_subtasks = [
        # Most recent first (sorted by message_id desc)
        Subtask(
            id=4,
            message_id=4,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "That's great!"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=3,
            message_id=3,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="I like Python",
            sender_type=SenderType.USER,
            sender_user_id=1,
        ),
        Subtask(
            id=2,
            message_id=2,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "Hello!"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=1,
            message_id=1,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hi there",
            sender_type=SenderType.USER,
            sender_user_id=1,
        ),
    ]

    # Build context with limit of 3 messages (2 history + 1 current)
    result = build_context_messages(
        db=db,
        existing_subtasks=existing_subtasks,
        current_message="How are you?",
        current_user=current_user,
        is_group_chat=False,
        context_limit=3,
    )

    # Should have 3 messages total (2 from history + 1 current)
    assert len(result) == 3

    # Check chronological order (oldest to newest)
    assert result[0] == {"role": "user", "content": "I like Python"}
    assert result[1] == {"role": "assistant", "content": "That's great!"}
    assert result[2] == {"role": "user", "content": "How are you?"}


def test_build_context_messages_group_chat():
    """Test building context messages for group chat with memory isolation.

    In group chat, only the current user's messages should use role="user".
    All other messages (other users' and AI) should use role="assistant".
    This prevents mem0 from attributing other users' messages as current user's memories.
    """
    # Mock database session
    db = MagicMock()

    # Create mock users
    current_user = User(id=1, user_name="alice")
    sender_bob = User(id=2, user_name="bob")

    # Mock db.query().filter().first() to return sender_bob
    db.query.return_value.filter.return_value.first.return_value = sender_bob

    # Create mock subtasks with different senders
    existing_subtasks = [
        Subtask(
            id=2,
            message_id=2,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "Hello Bob!"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=1,
            message_id=1,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hi everyone",
            sender_type=SenderType.USER,
            sender_user_id=2,  # Bob sent this (not current user)
        ),
    ]

    # Build context with group chat enabled
    result = build_context_messages(
        db=db,
        existing_subtasks=existing_subtasks,
        current_message="How are you all?",
        current_user=current_user,
        is_group_chat=True,
        context_limit=3,
    )

    # Should have 3 messages
    assert len(result) == 3

    # Bob's message should be role="assistant" (not current user)
    # AI response should also be role="assistant"
    # Only Alice's current message should be role="user"
    assert result[0] == {"role": "assistant", "content": "User[bob]: Hi everyone"}
    assert result[1] == {"role": "assistant", "content": "AI: Hello Bob!"}
    assert result[2] == {"role": "user", "content": "User[alice]: How are you all?"}


def test_build_context_messages_skip_incomplete():
    """Test that incomplete subtasks are skipped."""
    db = MagicMock()
    current_user = User(id=1, user_name="alice")

    # Mix of completed and incomplete subtasks
    existing_subtasks = [
        Subtask(
            id=3,
            message_id=3,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.PENDING,  # Not completed
            result={"value": "Incomplete response"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=2,
            message_id=2,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hello",
            sender_type=SenderType.USER,
            sender_user_id=1,
        ),
        Subtask(
            id=1,
            message_id=1,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.FAILED,  # Failed
            result={"value": "Failed response"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
    ]

    result = build_context_messages(
        db=db,
        existing_subtasks=existing_subtasks,
        current_message="Are you there?",
        current_user=current_user,
        is_group_chat=False,
        context_limit=5,
    )

    # Should only have 2 messages: 1 completed history + 1 current
    assert len(result) == 2
    assert result[0] == {"role": "user", "content": "Hello"}
    assert result[1] == {"role": "user", "content": "Are you there?"}


def test_build_context_messages_empty_history():
    """Test building context with no existing history."""
    db = MagicMock()
    current_user = User(id=1, user_name="alice")

    result = build_context_messages(
        db=db,
        existing_subtasks=[],
        current_message="First message",
        current_user=current_user,
        is_group_chat=False,
        context_limit=3,
    )

    # Should only have the current message
    assert len(result) == 1
    assert result[0] == {"role": "user", "content": "First message"}


def test_build_context_messages_exceeds_limit():
    """Test that only the most recent messages are kept when exceeding limit."""
    db = MagicMock()
    current_user = User(id=1, user_name="alice")

    # Create 10 completed subtasks
    existing_subtasks = []
    for i in range(10, 0, -1):  # Descending order (most recent first)
        role = SubtaskRole.USER if i % 2 == 1 else SubtaskRole.ASSISTANT
        existing_subtasks.append(
            Subtask(
                id=i,
                message_id=i,
                role=role,
                status=SubtaskStatus.COMPLETED,
                prompt=f"Message {i}" if role == SubtaskRole.USER else "",
                result=(
                    {"value": f"Response {i}"}
                    if role == SubtaskRole.ASSISTANT
                    else None
                ),
                sender_type=(
                    SenderType.USER if role == SubtaskRole.USER else SenderType.TEAM
                ),
                sender_user_id=1 if role == SubtaskRole.USER else 0,
            )
        )

    # Limit to 3 messages (2 history + 1 current)
    result = build_context_messages(
        db=db,
        existing_subtasks=existing_subtasks,
        current_message="Latest message",
        current_user=current_user,
        is_group_chat=False,
        context_limit=3,
    )

    # Should have exactly 3 messages
    assert len(result) == 3

    # Should have the 2 most recent completed messages + current
    assert result[0]["content"] == "Message 9"
    assert result[1]["content"] == "Response 10"
    assert result[2]["content"] == "Latest message"


def test_build_context_messages_group_chat_with_current_user_history():
    """Test group chat where current user has messages in history.

    When the current user (alice) has messages in history, those should use role="user".
    Other users' messages should still use role="assistant".
    """
    db = MagicMock()
    current_user = User(id=1, user_name="alice")
    sender_bob = User(id=2, user_name="bob")
    sender_alice = User(id=1, user_name="alice")

    # Mock db.query to return correct user based on sender_user_id
    def mock_filter(*args, **kwargs):
        mock_result = MagicMock()
        # Return alice for sender_user_id=1, bob for sender_user_id=2
        if hasattr(args[0], "right") and hasattr(args[0].right, "value"):
            if args[0].right.value == 1:
                mock_result.first.return_value = sender_alice
            else:
                mock_result.first.return_value = sender_bob
        else:
            mock_result.first.return_value = sender_bob
        return mock_result

    db.query.return_value.filter = mock_filter

    existing_subtasks = [
        # Most recent first
        Subtask(
            id=4,
            message_id=4,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "Hi Alice!"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=3,
            message_id=3,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hello everyone, I'm Alice",
            sender_type=SenderType.USER,
            sender_user_id=1,  # Alice (current user)
        ),
        Subtask(
            id=2,
            message_id=2,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "Hi Bob!"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=1,
            message_id=1,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hi, I'm Bob",
            sender_type=SenderType.USER,
            sender_user_id=2,  # Bob (not current user)
        ),
    ]

    result = build_context_messages(
        db=db,
        existing_subtasks=existing_subtasks,
        current_message="How is everyone?",
        current_user=current_user,
        is_group_chat=True,
        context_limit=5,  # Include all history
    )

    # Should have 5 messages
    assert len(result) == 5

    # Bob's message -> role="assistant" (not current user)
    assert result[0]["role"] == "assistant"
    assert "User[bob]:" in result[0]["content"]

    # AI response to Bob -> role="assistant"
    assert result[1]["role"] == "assistant"
    assert result[1]["content"] == "AI: Hi Bob!"

    # Alice's history message -> role="user" (IS current user)
    assert result[2]["role"] == "user"
    assert "User[alice]:" in result[2]["content"]

    # AI response to Alice -> role="assistant"
    assert result[3]["role"] == "assistant"
    assert result[3]["content"] == "AI: Hi Alice!"

    # Alice's current message -> role="user"
    assert result[4]["role"] == "user"
    assert "User[alice]:" in result[4]["content"]


def test_build_context_messages_group_chat_only_other_users():
    """Test group chat where history only contains other users' messages.

    All history messages should use role="assistant".
    Only the current message should use role="user".
    """
    db = MagicMock()
    current_user = User(id=1, user_name="alice")
    sender_bob = User(id=2, user_name="bob")
    sender_charlie = User(id=3, user_name="charlie")

    # Mock db to return appropriate users
    def mock_filter(*args, **kwargs):
        mock_result = MagicMock()
        # Return bob or charlie based on sender_user_id
        if hasattr(args[0], "right") and hasattr(args[0].right, "value"):
            if args[0].right.value == 2:
                mock_result.first.return_value = sender_bob
            elif args[0].right.value == 3:
                mock_result.first.return_value = sender_charlie
        else:
            mock_result.first.return_value = sender_bob
        return mock_result

    db.query.return_value.filter = mock_filter

    existing_subtasks = [
        Subtask(
            id=3,
            message_id=3,
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "Hi Charlie!"},
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        ),
        Subtask(
            id=2,
            message_id=2,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hey Bob!",
            sender_type=SenderType.USER,
            sender_user_id=3,  # Charlie
        ),
        Subtask(
            id=1,
            message_id=1,
            role=SubtaskRole.USER,
            status=SubtaskStatus.COMPLETED,
            prompt="Hello!",
            sender_type=SenderType.USER,
            sender_user_id=2,  # Bob
        ),
    ]

    result = build_context_messages(
        db=db,
        existing_subtasks=existing_subtasks,
        current_message="Hi everyone, I'm Alice!",
        current_user=current_user,
        is_group_chat=True,
        context_limit=4,
    )

    # Should have 4 messages
    assert len(result) == 4

    # All history messages should be role="assistant" since none are from current user
    assert result[0]["role"] == "assistant"  # Bob's message
    assert result[1]["role"] == "assistant"  # Charlie's message
    assert result[2]["role"] == "assistant"  # AI response

    # Only current message should be role="user"
    assert result[3]["role"] == "user"
    assert "User[alice]:" in result[3]["content"]
