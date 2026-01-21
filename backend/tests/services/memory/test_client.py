# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for LongTermMemoryClient."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest

from app.services.memory.client import LongTermMemoryClient
from app.services.memory.schemas import MemorySearchResponse, MemorySearchResult


@pytest.fixture
def memory_client() -> LongTermMemoryClient:
    """Create a test memory client."""
    return LongTermMemoryClient(
        base_url="http://localhost:8080", api_key="test-key", timeout=5.0
    )


@pytest.mark.asyncio
async def test_add_memory_success(memory_client) -> None:
    """Test successful memory addition."""
    mock_response = MagicMock()
    mock_response.status = 200
    mock_response.json = AsyncMock(return_value={"id": "test-memory-id"})

    with patch("aiohttp.ClientSession.post") as mock_post:
        mock_post.return_value.__aenter__.return_value = mock_response

        result = await memory_client.add_memory(
            user_id="123",
            messages=[{"role": "user", "content": "Test message"}],
            metadata={"task_id": 456},
        )

        assert result is not None
        assert result["id"] == "test-memory-id"


@pytest.mark.asyncio
async def test_add_memory_service_unavailable(memory_client) -> None:
    """Test memory addition when service is unavailable."""
    with patch("aiohttp.ClientSession.post") as mock_post:
        mock_post.side_effect = aiohttp.ClientError("Connection refused")

        result = await memory_client.add_memory(
            user_id="123",
            messages=[{"role": "user", "content": "Test message"}],
            metadata={"task_id": 456},
        )

        assert result is None  # Graceful degradation


@pytest.mark.asyncio
async def test_add_memory_timeout(memory_client) -> None:
    """Test memory addition timeout."""
    with patch("aiohttp.ClientSession.post") as mock_post:
        mock_post.side_effect = asyncio.TimeoutError()

        result = await memory_client.add_memory(
            user_id="123",
            messages=[{"role": "user", "content": "Test message"}],
            metadata={"task_id": 456},
        )

        assert result is None  # Graceful degradation


@pytest.mark.asyncio
async def test_search_memories_success(memory_client) -> None:
    """Test successful memory search."""
    mock_response = MagicMock()
    mock_response.status = 200
    mock_response.json = AsyncMock(
        return_value={
            "results": [
                {
                    "id": "mem-1",
                    "memory": "User prefers Python",
                    "metadata": {"task_id": 123},
                }
            ]
        }
    )

    with patch("aiohttp.ClientSession.post") as mock_post:
        mock_post.return_value.__aenter__.return_value = mock_response

        result = await memory_client.search_memories(
            user_id="123", query="programming language", limit=5
        )

        assert len(result.results) == 1
        assert result.results[0].id == "mem-1"
        assert result.results[0].memory == "User prefers Python"


@pytest.mark.asyncio
async def test_search_memories_timeout(memory_client) -> None:
    """Test memory search timeout."""
    with patch("aiohttp.ClientSession.post") as mock_post:
        mock_post.side_effect = asyncio.TimeoutError()

        result = await memory_client.search_memories(
            user_id="123", query="test", timeout=2.0
        )

        assert len(result.results) == 0  # Empty results on timeout


@pytest.mark.asyncio
async def test_delete_memory_success(memory_client) -> None:
    """Test successful memory deletion."""
    mock_response = MagicMock()
    mock_response.status = 200

    with patch("aiohttp.ClientSession.delete") as mock_delete:
        mock_delete.return_value.__aenter__.return_value = mock_response

        result = await memory_client.delete_memory("test-memory-id")

        assert result is True


@pytest.mark.asyncio
async def test_delete_memory_not_found(memory_client) -> None:
    """Test memory deletion when memory not found."""
    mock_response = MagicMock()
    mock_response.status = 404
    mock_response.text = AsyncMock(return_value="Not found")

    with patch("aiohttp.ClientSession.delete") as mock_delete:
        mock_delete.return_value.__aenter__.return_value = mock_response

        result = await memory_client.delete_memory("non-existent-id")

        assert result is False
