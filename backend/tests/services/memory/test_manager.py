# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for MemoryManager."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.memory.manager import MemoryManager
from app.services.memory.schemas import MemorySearchResponse, MemorySearchResult


@pytest.fixture
def mock_settings():
    """Mock settings for testing."""
    with patch("app.services.memory.manager.settings") as mock_settings:
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"
        mock_settings.MEMORY_API_KEY = "test-key"
        mock_settings.MEMORY_TIMEOUT_SECONDS = 2.0
        mock_settings.MEMORY_MAX_RESULTS = 5
        yield mock_settings


@pytest.fixture
def memory_manager(mock_settings) -> MemoryManager:
    """Create a test memory manager with fresh instance."""
    # Reset singleton
    MemoryManager._instance = None
    return MemoryManager.get_instance()


@pytest.mark.asyncio
async def test_search_memories_enabled(memory_manager):
    """Test cross-conversation memory search when feature is enabled."""
    mock_client = AsyncMock()
    mock_client.search_memories.return_value = MemorySearchResponse(
        results=[
            MemorySearchResult(
                id="mem-1",
                memory="User prefers Python",
                metadata={"task_id": "123", "team_id": "456"},
            ),
            MemorySearchResult(
                id="mem-2",
                memory="User works on backend development",
                metadata={"task_id": "789", "team_id": "456"},
            ),
        ]
    )

    memory_manager._client = mock_client

    results = await memory_manager.search_memories(
        user_id="1", query="Python preference"
    )

    assert len(results) == 2
    assert results[0].id == "mem-1"
    assert results[1].id == "mem-2"
    # Verify it searches across all conversations (no task_id/team_id filter)
    mock_client.search_memories.assert_called_once()
    call_args = mock_client.search_memories.call_args
    # Verify filters is None or empty dict (no task_id/team_id filtering)
    filters = call_args[1].get("filters")
    assert filters is None or filters == {}


@pytest.mark.asyncio
async def test_search_memories_disabled():
    """Test memory search when feature is disabled."""
    with patch("app.services.memory.manager.settings") as mock_settings:
        mock_settings.MEMORY_ENABLED = False

        # Reset singleton
        MemoryManager._instance = None
        manager = MemoryManager.get_instance()

        results = await manager.search_memories(user_id="1", query="test")

        assert len(results) == 0


@pytest.mark.asyncio
async def test_save_user_message_async_enabled(memory_manager):
    """Test saving user message when feature is enabled."""
    mock_client = AsyncMock()
    mock_client.add_memory.return_value = {"results": [{"id": "new-memory-id"}]}

    memory_manager._client = mock_client

    await memory_manager.save_user_message_async(
        user_id="1",
        team_id="456",
        task_id="123",
        subtask_id="789",
        messages=[{"role": "user", "content": "Test message"}],
    )

    mock_client.add_memory.assert_called_once()
    call_args = mock_client.add_memory.call_args
    assert call_args[1]["user_id"] == "1"
    assert call_args[1]["messages"] == [{"role": "user", "content": "Test message"}]
    assert call_args[1]["metadata"]["task_id"] == "123"


@pytest.mark.asyncio
async def test_save_user_message_async_disabled():
    """Test saving user message when feature is disabled."""
    with patch("app.services.memory.manager.settings") as mock_settings:
        mock_settings.MEMORY_ENABLED = False

        # Reset singleton
        MemoryManager._instance = None
        manager = MemoryManager.get_instance()

        # Should not raise an exception
        await manager.save_user_message_async(
            user_id="1",
            team_id="456",
            task_id="123",
            subtask_id="789",
            messages=[{"role": "user", "content": "Test message"}],
        )


@pytest.mark.asyncio
async def test_cleanup_task_memories(memory_manager):
    """Test cleanup of task memories."""
    mock_client = AsyncMock()
    mock_client.search_memories.return_value = MemorySearchResponse(
        results=[
            MemorySearchResult(
                id="mem-1", memory="Memory 1", metadata={"task_id": 123}
            ),
            MemorySearchResult(
                id="mem-2", memory="Memory 2", metadata={"task_id": 123}
            ),
        ]
    )
    mock_client.delete_memory.return_value = True

    memory_manager._client = mock_client

    deleted_count = await memory_manager.cleanup_task_memories(
        user_id="1", task_id="123"
    )

    assert deleted_count == 2
    assert mock_client.delete_memory.call_count == 2


@pytest.mark.asyncio
async def test_cleanup_task_memories_no_memories(memory_manager):
    """Test cleanup when no memories exist."""
    mock_client = AsyncMock()
    mock_client.search_memories.return_value = MemorySearchResponse(results=[])

    memory_manager._client = mock_client

    deleted_count = await memory_manager.cleanup_task_memories(
        user_id="1", task_id="123"
    )

    assert deleted_count == 0
    mock_client.delete_memory.assert_not_called()


def test_inject_memories_to_prompt(memory_manager):
    """Test injecting memories into system prompt."""
    memories = [
        MemorySearchResult(
            id="mem-1",
            memory="User prefers Python",
            metadata={"created_at": "2025-01-15T10:00:00Z"},
        ),
        MemorySearchResult(
            id="mem-2", memory="Project uses FastAPI", metadata={"created_at": ""}
        ),
    ]

    base_prompt = "You are a helpful assistant."
    enhanced_prompt = memory_manager.inject_memories_to_prompt(base_prompt, memories)

    assert "<memory>" in enhanced_prompt
    assert "User prefers Python" in enhanced_prompt
    assert "Project uses FastAPI" in enhanced_prompt
    assert base_prompt in enhanced_prompt
    assert enhanced_prompt.index("<memory>") < enhanced_prompt.index(base_prompt)


def test_inject_memories_to_prompt_empty(memory_manager):
    """Test injecting empty memories."""
    base_prompt = "You are a helpful assistant."
    enhanced_prompt = memory_manager.inject_memories_to_prompt(base_prompt, [])

    assert enhanced_prompt == base_prompt  # No change
