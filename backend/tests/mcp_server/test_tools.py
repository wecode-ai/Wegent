# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP Server tools."""

import json
import pytest
from unittest.mock import MagicMock, patch

from app.mcp_server.auth import TaskTokenInfo


class TestSilentExitTool:
    """Tests for silent_exit tool."""

    def test_silent_exit_returns_marker(self):
        """Test that silent_exit returns the correct marker without token_info."""
        from app.mcp_server.tools.silent_exit import silent_exit

        # When token_info is None, no database access is needed
        result = silent_exit(reason="test reason")
        parsed = json.loads(result)

        assert parsed["__silent_exit__"] is True
        assert parsed["reason"] == "test reason"

    def test_silent_exit_empty_reason(self):
        """Test silent_exit with empty reason."""
        from app.mcp_server.tools.silent_exit import silent_exit

        # When token_info is None, no database access is needed
        result = silent_exit()
        parsed = json.loads(result)

        assert parsed["__silent_exit__"] is True
        assert parsed["reason"] == ""

    def test_silent_exit_with_token_info(self):
        """Test silent_exit with token info - verifies marker is returned."""
        from app.mcp_server.tools.silent_exit import silent_exit

        token_info = TaskTokenInfo(
            task_id=123,
            subtask_id=456,
            user_id=789,
            user_name="testuser",
        )

        # Mock _update_subtask_silent_exit to avoid database dependency
        with patch(
            "app.mcp_server.tools.silent_exit._update_subtask_silent_exit"
        ) as mock_update:
            result = silent_exit(reason="completed", token_info=token_info)

            # Should attempt to update the database
            mock_update.assert_called_once_with(456, "completed")

            parsed = json.loads(result)
            assert parsed["__silent_exit__"] is True
            assert parsed["reason"] == "completed"


class TestSilentExitMarkerDetection:
    """Tests for detecting silent_exit marker in responses."""

    def test_detect_silent_exit_marker(self):
        """Test detection of __silent_exit__ marker in tool output."""
        tool_output = json.dumps({"__silent_exit__": True, "reason": "normal status"})

        parsed = json.loads(tool_output)
        assert parsed.get("__silent_exit__") is True
        assert parsed.get("reason") == "normal status"

    def test_non_silent_exit_output(self):
        """Test that normal output doesn't trigger false positive."""
        tool_output = json.dumps({"success": True, "data": "some data"})

        parsed = json.loads(tool_output)
        assert parsed.get("__silent_exit__") is not True

    def test_invalid_json_output(self):
        """Test handling of non-JSON output."""
        tool_output = "plain text output"

        try:
            parsed = json.loads(tool_output)
            is_silent = parsed.get("__silent_exit__")
        except json.JSONDecodeError:
            is_silent = False

        assert is_silent is False
