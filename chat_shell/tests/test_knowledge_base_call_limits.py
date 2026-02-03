"""Test knowledge base tool call limits with HTTP-fetched configuration.

This test verifies that KB call limit configuration is properly fetched
from Backend API and used by KnowledgeBaseTool.
"""

from unittest.mock import AsyncMock, patch

import pytest

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
        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
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

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
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

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
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

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
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

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
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


class TestCallCountIncrementTiming:
    """Test that call count increments correctly during consecutive calls.

    These tests verify the fix for the bug where multiple consecutive calls
    were not correctly incrementing _call_count, causing all calls in the
    exempt period to show "Call 1/N".
    """

    @pytest.mark.asyncio
    async def test_call_count_increments_after_check_passes(self):
        """Test that _call_count increments immediately after _check_call_limits passes."""
        # Arrange: Create tool with known limits
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "max_calls_per_conversation": 5,
                    "exempt_calls_before_check": 2,
                    "name": "Test KB",
                }
            ],
        }

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
            mock_http.return_value = mock_kb_info
            await tool._get_kb_info()

            # Initial state
            assert tool._call_count == 0

            # First check - should allow and show Call 1/5
            should_allow, rejection_reason, warning_level = tool._check_call_limits(
                "query1"
            )
            assert should_allow is True
            assert rejection_reason is None
            assert (
                tool._call_count == 0
            )  # Not incremented yet (check only, no increment)

            # Simulate what _arun does: increment after check passes
            tool._call_count += 1
            assert tool._call_count == 1

            # Second check - should allow and show Call 2/5
            should_allow, rejection_reason, warning_level = tool._check_call_limits(
                "query2"
            )
            assert should_allow is True
            assert tool._call_count == 1  # Still 1 (check only)

            tool._call_count += 1
            assert tool._call_count == 2

            # Third check - should allow with warning (check period) and show Call 3/5
            should_allow, rejection_reason, warning_level = tool._check_call_limits(
                "query3"
            )
            assert should_allow is True
            assert warning_level == "normal"  # Now in check period
            assert tool._call_count == 2  # Still 2 (check only)

            tool._call_count += 1
            assert tool._call_count == 3

    @pytest.mark.asyncio
    async def test_max_calls_rejection_after_limit_reached(self):
        """Test that calls are rejected after max_calls is reached."""
        # Arrange: Create tool with max_calls=2
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "max_calls_per_conversation": 2,
                    "exempt_calls_before_check": 1,
                    "name": "Test KB",
                }
            ],
        }

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
            mock_http.return_value = mock_kb_info
            await tool._get_kb_info()

            # Call 1: Should allow (exempt period)
            should_allow, rejection_reason, _ = tool._check_call_limits("query1")
            assert should_allow is True
            assert rejection_reason is None
            tool._call_count += 1  # Simulate _arun behavior

            # Call 2: Should allow (check period, but within limit)
            should_allow, rejection_reason, warning_level = tool._check_call_limits(
                "query2"
            )
            assert should_allow is True
            assert rejection_reason is None
            assert warning_level == "normal"  # In check period
            tool._call_count += 1  # Simulate _arun behavior

            # Call 3: Should be REJECTED (exceeds max_calls=2)
            should_allow, rejection_reason, _ = tool._check_call_limits("query3")
            assert should_allow is False
            assert rejection_reason == "max_calls_exceeded"
            # Call count should NOT increment for rejected calls
            assert tool._call_count == 2

    @pytest.mark.asyncio
    async def test_consecutive_calls_correct_counting(self):
        """Test that consecutive calls are counted correctly even in exempt period.

        This test specifically verifies the fix for the bug where multiple calls
        in the exempt period all showed "Call 1/N" instead of 1/N, 2/N, 3/N...
        """
        # Arrange: max=5, exempt=3
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "max_calls_per_conversation": 5,
                    "exempt_calls_before_check": 3,
                    "name": "Test KB",
                }
            ],
        }

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
            mock_http.return_value = mock_kb_info
            await tool._get_kb_info()

            call_results = []

            # Simulate 6 consecutive calls
            for i in range(6):
                should_allow, rejection_reason, warning_level = tool._check_call_limits(
                    f"query{i+1}"
                )

                if should_allow:
                    tool._call_count += 1  # Simulate _arun behavior

                call_results.append(
                    {
                        "call_number": i + 1,
                        "should_allow": should_allow,
                        "rejection_reason": rejection_reason,
                        "warning_level": warning_level,
                        "call_count_after": tool._call_count,
                    }
                )

            # Verify results:
            # Calls 1-3: exempt period, allowed, no warning
            assert call_results[0]["should_allow"] is True
            assert call_results[0]["warning_level"] is None
            assert call_results[0]["call_count_after"] == 1

            assert call_results[1]["should_allow"] is True
            assert call_results[1]["warning_level"] is None
            assert call_results[1]["call_count_after"] == 2

            assert call_results[2]["should_allow"] is True
            assert call_results[2]["warning_level"] is None
            assert call_results[2]["call_count_after"] == 3

            # Calls 4-5: check period, allowed with warning
            assert call_results[3]["should_allow"] is True
            assert call_results[3]["warning_level"] == "normal"
            assert call_results[3]["call_count_after"] == 4

            assert call_results[4]["should_allow"] is True
            assert call_results[4]["warning_level"] == "normal"
            assert call_results[4]["call_count_after"] == 5

            # Call 6: rejected (exceeds max_calls=5)
            assert call_results[5]["should_allow"] is False
            assert call_results[5]["rejection_reason"] == "max_calls_exceeded"
            assert call_results[5]["call_count_after"] == 5  # Not incremented

    @pytest.mark.asyncio
    async def test_rejection_message_shows_correct_count(self):
        """Test that rejection message shows the correct call count."""
        # Arrange: max=2
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "max_calls_per_conversation": 2,
                    "exempt_calls_before_check": 1,
                    "name": "Test KB",
                }
            ],
        }

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
            mock_http.return_value = mock_kb_info
            await tool._get_kb_info()

            # Make 2 successful calls
            for i in range(2):
                should_allow, _, _ = tool._check_call_limits(f"query{i+1}")
                if should_allow:
                    tool._call_count += 1

            # Third call should be rejected
            rejection_msg = tool._format_rejection_message("max_calls_exceeded", 2)

            import json

            msg_data = json.loads(rejection_msg)

            assert msg_data["status"] == "rejected"
            assert msg_data["reason"] == "max_calls_exceeded"
            assert msg_data["call_count"] == 2  # Shows the actual successful calls
            assert msg_data["max_calls"] == 2
            assert "2 successful calls" in msg_data["message"]

    @pytest.mark.asyncio
    async def test_call_statistics_header_shows_correct_call_number(self):
        """Test that _build_call_statistics_header shows the correct call number.

        This verifies that after incrementing _call_count in _arun,
        the header correctly shows the current call number.
        """
        # Arrange
        tool = KnowledgeBaseTool(
            knowledge_base_ids=[1],
            user_id=123,
            context_window=200000,
        )

        mock_kb_info = {
            "total_file_size": 1000,
            "total_estimated_tokens": 250,
            "items": [
                {
                    "id": 1,
                    "max_calls_per_conversation": 5,
                    "exempt_calls_before_check": 2,
                    "name": "Test KB",
                }
            ],
        }

        with patch.object(
            tool, "_get_kb_info_via_http", new_callable=AsyncMock
        ) as mock_http:
            mock_http.return_value = mock_kb_info
            await tool._get_kb_info()

            # Simulate first call
            tool._call_count = 1  # As if _arun already incremented it
            header1 = tool._build_call_statistics_header(None, 10)
            assert "Call 1/5" in header1

            # Simulate second call
            tool._call_count = 2
            header2 = tool._build_call_statistics_header(None, 15)
            assert "Call 2/5" in header2

            # Simulate third call (in check period)
            tool._call_count = 3
            header3 = tool._build_call_statistics_header("normal", 20)
            assert "Call 3/5" in header3
            assert "check period" in header3
