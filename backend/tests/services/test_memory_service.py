# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for memory service."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx

from app.services.memory.service import MemoryService, get_memory_service


@pytest.fixture
def memory_service():
    """Create a memory service instance for testing."""
    return MemoryService()


@pytest.fixture
def mock_httpx_client():
    """Mock httpx AsyncClient."""
    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock()
    client.delete = AsyncMock()
    client.aclose = AsyncMock()
    return client


class TestMemoryServiceCore:
    """Test core memory service functionality."""

    @patch("app.services.memory.service.settings")
    def test_enabled_property_when_disabled(self, mock_settings, memory_service):
        """Test enabled property returns False when MEMORY_ENABLED is False."""
        mock_settings.MEMORY_ENABLED = False
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        assert memory_service.enabled is False

    @patch("app.services.memory.service.settings")
    def test_enabled_property_when_no_base_url(self, mock_settings, memory_service):
        """Test enabled property returns False when MEMORY_BASE_URL is empty."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = ""

        assert memory_service.enabled is False

    @patch("app.services.memory.service.settings")
    def test_enabled_property_when_enabled(self, mock_settings, memory_service):
        """Test enabled property returns True when properly configured."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        assert memory_service.enabled is True


class TestMemoryRetrieval:
    """Test memory retrieval functionality."""

    @patch("app.services.memory.service.settings")
    async def test_retrieve_returns_empty_when_disabled(
        self, mock_settings, memory_service
    ):
        """Test retrieve_for_chat returns empty string when service is disabled."""
        mock_settings.MEMORY_ENABLED = False
        mock_settings.MEMORY_BASE_URL = ""

        result = await memory_service.retrieve_for_chat(
            user_id=1,
            team_id=2,
            task_id=3,
            query="test query",
        )

        assert result == ""

    @patch("app.services.memory.service.settings")
    async def test_retrieve_success(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test successful memory retrieval."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"
        mock_settings.MEMORY_SEARCH_LIMIT = 10

        # Mock response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "results": [
                {"memory": "User prefers Python", "score": 0.95},
                {"memory": "User likes morning coffee", "score": 0.87},
            ]
        }
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        result = await memory_service.retrieve_for_chat(
            user_id=1,
            team_id=2,
            task_id=3,
            query="test query",
        )

        # Verify API call
        mock_httpx_client.post.assert_called_once_with(
            "/search",
            json={
                "query": "test query",
                "user_id": "user_1",
                "agent_id": "team_2",
                "run_id": "task_3",
                "limit": 10,
            },
        )

        # Verify XML formatting
        assert "<long_term_memory>" in result
        assert "以下是与当前用户相关的历史记忆" in result
        assert '<memory relevance="0.95">' in result
        assert "User prefers Python" in result
        assert '<memory relevance="0.87">' in result
        assert "User likes morning coffee" in result

    @patch("app.services.memory.service.settings")
    async def test_retrieve_with_group_chat(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test memory retrieval with group_id for group chat."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"
        mock_settings.MEMORY_SEARCH_LIMIT = 10

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"results": []}
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        await memory_service.retrieve_for_chat(
            user_id=1,
            team_id=2,
            task_id=3,
            query="test",
            group_id=999,
        )

        # run_id should still be task-based (group_id is in metadata during storage)
        call_args = mock_httpx_client.post.call_args[1]["json"]
        assert call_args["run_id"] == "task_3"

    @patch("app.services.memory.service.settings")
    async def test_retrieve_handles_empty_results(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test retrieve returns empty when no memories found."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"results": []}
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        result = await memory_service.retrieve_for_chat(
            user_id=1, team_id=2, task_id=3, query="test"
        )

        assert result == ""

    @patch("app.services.memory.service.settings")
    async def test_retrieve_handles_http_error(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test retrieve handles HTTP errors gracefully."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        result = await memory_service.retrieve_for_chat(
            user_id=1, team_id=2, task_id=3, query="test"
        )

        assert result == ""

    @patch("app.services.memory.service.settings")
    async def test_retrieve_handles_exception(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test retrieve handles exceptions gracefully."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        mock_httpx_client.post.side_effect = Exception("Network error")
        memory_service._client = mock_httpx_client

        result = await memory_service.retrieve_for_chat(
            user_id=1, team_id=2, task_id=3, query="test"
        )

        assert result == ""


class TestMemoryStorage:
    """Test memory storage functionality."""

    @patch("app.services.memory.service.settings")
    def test_store_skips_when_disabled(self, mock_settings, memory_service):
        """Test store_exchange does nothing when service is disabled."""
        mock_settings.MEMORY_ENABLED = False

        # Should return immediately without error
        memory_service.store_exchange(
            user_id=1,
            team_id=2,
            task_id=3,
            user_message="Hello",
            assistant_message="Hi there",
        )

    @patch("app.services.memory.service.settings")
    @patch("app.services.memory.service.asyncio.create_task")
    def test_store_filters_trivial_messages(
        self, mock_create_task, mock_settings, memory_service
    ):
        """Test store_exchange filters out trivial messages."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"
        mock_settings.MEMORY_FILTER_MIN_LENGTH = 10
        mock_settings.MEMORY_FILTER_PHRASES = "hey,hi,ok,thanks"

        # Should not create task for short message
        memory_service.store_exchange(
            user_id=1,
            team_id=2,
            task_id=3,
            user_message="hi",
            assistant_message="ok",
        )

        mock_create_task.assert_not_called()

    @patch("app.services.memory.service.settings")
    @patch("app.services.memory.service.asyncio.create_task")
    def test_store_accepts_meaningful_messages(
        self, mock_create_task, mock_settings, memory_service
    ):
        """Test store_exchange accepts meaningful messages."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"
        mock_settings.MEMORY_FILTER_MIN_LENGTH = 10
        mock_settings.MEMORY_FILTER_PHRASES = "hey,hi,ok,thanks"

        memory_service.store_exchange(
            user_id=1,
            team_id=2,
            task_id=3,
            user_message="I prefer using Python for data analysis",
            assistant_message="Great choice! Python has excellent data science libraries.",
        )

        mock_create_task.assert_called_once()

    @patch("app.services.memory.service.settings")
    async def test_store_async_success(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test _store_exchange_async successfully stores memory."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        await memory_service._store_exchange_async(
            user_id=1,
            team_id=2,
            task_id=3,
            user_message="I like Python",
            assistant_message="Great choice",
            workspace_id=100,
            group_id=None,
            is_group_chat=False,
            sender_name=None,
        )

        # Verify API call
        mock_httpx_client.post.assert_called_once()
        call_args = mock_httpx_client.post.call_args[1]["json"]
        assert call_args["user_id"] == "user_1"
        assert call_args["agent_id"] == "team_2"
        assert call_args["run_id"] == "task_3"
        assert len(call_args["messages"]) == 2
        assert call_args["messages"][0]["role"] == "user"
        assert call_args["messages"][1]["role"] == "assistant"
        assert call_args["metadata"]["task_id"] == 3
        assert call_args["metadata"]["team_id"] == 2

    @patch("app.services.memory.service.settings")
    async def test_store_async_with_group_chat(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test storage with group chat metadata."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        await memory_service._store_exchange_async(
            user_id=1,
            team_id=2,
            task_id=3,
            user_message="Hello team",
            assistant_message="Hi Alice",
            workspace_id=100,
            group_id=999,
            is_group_chat=True,
            sender_name="Alice",
        )

        call_args = mock_httpx_client.post.call_args[1]["json"]
        assert call_args["messages"][0]["name"] == "Alice"
        assert call_args["metadata"]["is_group_chat"] is True
        assert call_args["metadata"]["group_id"] == 999
        assert call_args["metadata"]["sender_name"] == "Alice"


class TestMemoryDeletion:
    """Test memory deletion functionality."""

    @patch("app.services.memory.service.settings")
    def test_delete_skips_when_disabled(self, mock_settings, memory_service):
        """Test delete_by_task does nothing when service is disabled."""
        mock_settings.MEMORY_ENABLED = False

        # Should return immediately without error
        memory_service.delete_by_task(task_id=123)

    @patch("app.services.memory.service.settings")
    async def test_delete_async_uses_bulk_delete(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test deletion tries bulk delete endpoint first."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_httpx_client.post.return_value = mock_response

        memory_service._client = mock_httpx_client

        await memory_service._delete_by_task_async(task_id=123)

        # Should call bulk delete endpoint
        mock_httpx_client.post.assert_called_once_with(
            "/v1/memories/delete",
            json={"run_id": "task_123"},
        )
        # Should not try search-and-delete fallback
        assert mock_httpx_client.post.call_count == 1

    @patch("app.services.memory.service.settings")
    async def test_delete_async_fallback_to_search(
        self, mock_settings, memory_service, mock_httpx_client
    ):
        """Test deletion falls back to search-and-delete when bulk fails."""
        mock_settings.MEMORY_ENABLED = True
        mock_settings.MEMORY_BASE_URL = "http://localhost:8080"

        # Bulk delete fails
        bulk_response = MagicMock()
        bulk_response.status_code = 404

        # Search succeeds
        search_response = MagicMock()
        search_response.status_code = 200
        search_response.json.return_value = {
            "results": [
                {"id": "mem_1"},
                {"id": "mem_2"},
            ]
        }

        mock_httpx_client.post.side_effect = [bulk_response, search_response]
        mock_httpx_client.delete = AsyncMock()

        memory_service._client = mock_httpx_client

        await memory_service._delete_by_task_async(task_id=123)

        # Should try bulk delete first
        assert mock_httpx_client.post.call_count == 2
        # Should delete individual memories
        assert mock_httpx_client.delete.call_count == 2
        mock_httpx_client.delete.assert_any_call("/memories/mem_1")
        mock_httpx_client.delete.assert_any_call("/memories/mem_2")


class TestMemoryServiceSingleton:
    """Test memory service singleton."""

    def test_get_memory_service_returns_same_instance(self):
        """Test get_memory_service returns the same instance."""
        service1 = get_memory_service()
        service2 = get_memory_service()

        assert service1 is service2

    async def test_close_client(self, memory_service, mock_httpx_client):
        """Test close method closes the HTTP client."""
        memory_service._client = mock_httpx_client

        await memory_service.close()

        mock_httpx_client.aclose.assert_called_once()
        assert memory_service._client is None
