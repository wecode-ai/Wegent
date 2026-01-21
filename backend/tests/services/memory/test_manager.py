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
        mock_settings.MEMORY_USER_ID_PREFIX = "wegent_user:"
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
async def test_search_memories_with_project_id(memory_manager):
    """Test memory search with project_id prioritization."""
    mock_client = AsyncMock()

    # First call: project-specific memories
    project_memories = MemorySearchResponse(
        results=[
            MemorySearchResult(
                id="proj-mem-1",
                memory="Project-specific memory 1",
                metadata={"task_id": "123", "project_id": "proj-1"},
            ),
            MemorySearchResult(
                id="proj-mem-2",
                memory="Project-specific memory 2",
                metadata={"task_id": "456", "project_id": "proj-1"},
            ),
        ]
    )

    # Second call: general memories (filtered to exclude project_id)
    general_memories = MemorySearchResponse(
        results=[
            MemorySearchResult(
                id="gen-mem-1",
                memory="General memory 1",
                metadata={"task_id": "789"},
            ),
            MemorySearchResult(
                id="proj-mem-1",
                memory="Project-specific memory 1",
                metadata={"task_id": "123", "project_id": "proj-1"},
            ),
            MemorySearchResult(
                id="gen-mem-2",
                memory="General memory 2",
                metadata={"task_id": "999"},
            ),
        ]
    )

    mock_client.search_memories.side_effect = [project_memories, general_memories]
    memory_manager._client = mock_client

    results = await memory_manager.search_memories(
        user_id="1", query="test query", project_id="proj-1"
    )

    # Should have 2 project memories + 2 general memories (filtered), limited to 5 total
    assert len(results) == 4
    assert results[0].id == "proj-mem-1"
    assert results[1].id == "proj-mem-2"
    # General memories should exclude those with matching project_id
    assert results[2].id == "gen-mem-1"
    assert results[3].id == "gen-mem-2"

    # Verify two searches were made
    assert mock_client.search_memories.call_count == 2

    # First call should filter by project_id
    first_call_filters = mock_client.search_memories.call_args_list[0][1]["filters"]
    assert first_call_filters == {"project_id": "proj-1"}

    # Second call should have no filters (search all)
    second_call_filters = mock_client.search_memories.call_args_list[1][1]["filters"]
    assert second_call_filters is None


@pytest.mark.asyncio
async def test_search_memories_project_only(memory_manager):
    """Test memory search when only project memories are found."""
    mock_client = AsyncMock()

    # First call: enough project memories to fill max_results
    project_memories = MemorySearchResponse(
        results=[
            MemorySearchResult(
                id=f"proj-mem-{i}",
                memory=f"Project memory {i}",
                metadata={"task_id": str(i), "project_id": "proj-1"},
            )
            for i in range(5)  # Exactly max_results
        ]
    )

    mock_client.search_memories.return_value = project_memories
    memory_manager._client = mock_client

    results = await memory_manager.search_memories(
        user_id="1", query="test query", project_id="proj-1"
    )

    # Should only have project memories, no general search needed
    assert len(results) == 5
    assert all("proj-mem" in r.id for r in results)

    # Only one search should be made (project-specific)
    assert mock_client.search_memories.call_count == 1


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
    # User ID should be prefixed for resource isolation
    assert call_args[1]["user_id"] == "wegent_user:1"
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
    # Verify search_memories was called with correct parameters
    mock_client.search_memories.assert_called()
    call_args = mock_client.search_memories.call_args
    # User ID should be prefixed for resource isolation
    assert call_args[1]["user_id"] == "wegent_user:1"
    assert call_args[1]["query"] == "*"
    assert call_args[1]["filters"] == {"task_id": "123"}


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
            metadata={},
            created_at="2025-01-15T10:00:00Z",
        ),
        MemorySearchResult(
            id="mem-2", memory="Project uses FastAPI", metadata={}, created_at=None
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


def test_get_prefixed_user_id(memory_manager):
    """Test user ID prefix generation for resource isolation."""
    # Should add configured prefix to user ID
    prefixed_id = memory_manager._get_prefixed_user_id("123")
    assert prefixed_id == "wegent_user:123"

    # Should work with different user IDs
    prefixed_id = memory_manager._get_prefixed_user_id("user-abc-456")
    assert prefixed_id == "wegent_user:user-abc-456"


def test_get_prefixed_user_id_custom_prefix():
    """Test user ID prefix with custom configuration."""
    with patch("app.services.memory.manager.settings") as mock_settings:
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"
        mock_settings.MEMORY_API_KEY = "test-key"
        mock_settings.MEMORY_TIMEOUT_SECONDS = 2.0
        mock_settings.MEMORY_MAX_RESULTS = 5
        mock_settings.MEMORY_USER_ID_PREFIX = "custom_prefix:"

        # Reset singleton
        MemoryManager._instance = None
        manager = MemoryManager.get_instance()

        prefixed_id = manager._get_prefixed_user_id("456")
        assert prefixed_id == "custom_prefix:456"


@pytest.mark.asyncio
async def test_search_memories_uses_prefixed_user_id(memory_manager):
    """Test that search_memories uses prefixed user ID."""
    mock_client = AsyncMock()
    mock_client.search_memories.return_value = MemorySearchResponse(results=[])
    memory_manager._client = mock_client

    await memory_manager.search_memories(user_id="test-user", query="test query")

    # Verify prefixed user ID is used
    call_args = mock_client.search_memories.call_args
    assert call_args[1]["user_id"] == "wegent_user:test-user"
