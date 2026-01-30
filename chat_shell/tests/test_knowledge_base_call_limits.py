"""Test knowledge base tool call limits with HTTP-fetched configuration.

This test verifies that KB call limit configuration is properly fetched
from Backend API and used by KnowledgeBaseTool.
"""

import pytest
from unittest.mock import AsyncMock, patch

from chat_shell.tools.builtin import KnowledgeBaseTool


class TestKnowledgeBaseCallLimitsHTTP:
    """Test KB call limit configuration fetching from HTTP API."""

    @pytest.mark.asyncio
    async def test_kb_info_fetched_and_used(self):
        """Test that KB info is fetched from HTTP API and used for call limits."""
        # Arrange: Create tool without any injected config
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1, 2],
            user_id=123,
            context_window=200000,
        )

        # Mock HTTP response
        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "total_file_size": 600,
                    "document_count": 5,
                    "estimated_tokens": 150,
                    "max_calls_per_conversation": 15,
                    "exempt_calls_before_check": 7,
                    "name": "Test KB 1",
                },
                {
                    "id": 2,
                    "total_file_size": 400,
                    "document_count": 3,
                    "estimated_tokens": 100,
                    "max_calls_per_conversation": 20,
                    "exempt_calls_before_check": 10,
                    "name": "Test KB 2",
                },
            ],
        }

        # Mock the HTTP call
        with patch.object(tool, "_get_kb_info_via_http", new_callable=AsyncMock) as mock_http:
            mock_http.return_value = mock_kb_info

            # Act: Fetch KB info to populate cache
            await tool._get_kb_info()

            # Get limits (should use cached data)
            max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Uses first KB's config
        assert max_calls == 15
        assert exempt_calls == 7

    @pytest.mark.asyncio
    async def test_kb_name_from_http(self):
        """Test that KB name is extracted from HTTP response."""
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "total_file_size": 1000,
                    "document_count": 10,
                    "estimated_tokens": 250,
                    "max_calls_per_conversation": 10,
                    "exempt_calls_before_check": 5,
                    "name": "My Custom KB",
                }
            ],
        }

        with patch.object(tool, "_get_kb_info_via_http", new_callable=AsyncMock) as mock_http:
            mock_http.return_value = mock_kb_info

            # Populate cache
            await tool._get_kb_info()

            # Act
            kb_name = tool._get_kb_name()

        # Assert
        assert kb_name == "My Custom KB"

    def test_fallback_to_defaults_when_no_cache(self):
        """Test fallback to default limits when cache is not populated."""
        # Arrange: No HTTP call made, cache is None
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
        )

        # Act: Get limits without populating cache (should use defaults)
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Uses defaults
        assert max_calls == 10  # DEFAULT_MAX_CALLS_PER_CONVERSATION
        assert exempt_calls == 5  # DEFAULT_EXEMPT_CALLS_BEFORE_CHECK

    def test_fallback_name_when_no_cache(self):
        """Test fallback to KB-{id} name when cache is not populated."""
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[123],
            user_id=456,
        )

        # Act: Get name without populating cache
        kb_name = tool._get_kb_name()

        # Assert
        assert kb_name == "KB-123"

    @pytest.mark.asyncio
    async def test_invalid_config_validation(self):
        """Test that invalid config (exempt >= max) falls back to defaults."""
        # Arrange: Invalid config
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "total_file_size": 1000,
                    "document_count": 10,
                    "estimated_tokens": 250,
                    "max_calls_per_conversation": 10,
                    "exempt_calls_before_check": 15,  # Invalid: >= max
                    "name": "Invalid KB",
                }
            ],
        }

        with patch.object(tool, "_get_kb_info_via_http", new_callable=AsyncMock) as mock_http:
            mock_http.return_value = mock_kb_info

            await tool._get_kb_info()

            # Act
            max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Falls back to defaults
        assert max_calls == 10
        assert exempt_calls == 5

    @pytest.mark.asyncio
    async def test_multiple_kbs_uses_first_config(self):
        """Test that with multiple KBs, first KB's config is used."""
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1, 2],
            user_id=123,
        )

        mock_kb_info = {
            "total_file_size": 1400,
            "total_estimated_tokens": 350,
            "items": [
                {
                    "id": 1,
                    "total_file_size": 800,
                    "document_count": 8,
                    "estimated_tokens": 200,
                    "max_calls_per_conversation": 15,
                    "exempt_calls_before_check": 7,
                    "name": "First KB",
                },
                {
                    "id": 2,
                    "total_file_size": 600,
                    "document_count": 6,
                    "estimated_tokens": 150,
                    "max_calls_per_conversation": 25,
                    "exempt_calls_before_check": 12,
                    "name": "Second KB",
                },
            ],
        }

        with patch.object(tool, "_get_kb_info_via_http", new_callable=AsyncMock) as mock_http:
            mock_http.return_value = mock_kb_info

            await tool._get_kb_info()

            # Act
            max_calls, exempt_calls = tool._get_kb_limits()
            kb_name = tool._get_kb_name()

        # Assert: Uses first KB's config
        assert max_calls == 15
        assert exempt_calls == 7
        assert kb_name == "First KB"

    @pytest.mark.asyncio
    async def test_partial_config_uses_defaults_for_missing_fields(self):
        """Test that missing fields in response use defaults."""
        # Arrange: Partial response (missing exempt_calls_before_check)
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "total_file_size": 1000,
                    "document_count": 10,
                    "estimated_tokens": 250,
                    "max_calls_per_conversation": 20,
                    # Missing exempt_calls_before_check
                    "name": "Partial KB",
                }
            ],
        }

        with patch.object(tool, "_get_kb_info_via_http", new_callable=AsyncMock) as mock_http:
            mock_http.return_value = mock_kb_info

            await tool._get_kb_info()

            # Act
            max_calls, exempt_calls = tool._get_kb_limits()

        # Assert: Uses provided max_calls, defaults for exempt
        assert max_calls == 20
        assert exempt_calls == 5  # Default

    def test_empty_knowledge_base_ids_returns_defaults(self):
        """Test that empty KB IDs returns default limits."""
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[],
            user_id=123,
        )

        # Act
        max_calls, exempt_calls = tool._get_kb_limits()

        # Assert
        assert max_calls == 10
        assert exempt_calls == 5
