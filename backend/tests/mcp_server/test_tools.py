# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP Server tools."""

import importlib
import inspect
import json
import sys
from unittest.mock import MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo


def get_silent_exit_module():
    """Get the silent_exit module, handling import caching issues."""
    module_name = "app.mcp_server.tools.silent_exit"
    # Force import the module directly
    if module_name not in sys.modules:
        importlib.import_module(module_name)
    return sys.modules[module_name]


def get_knowledge_module():
    """Get the knowledge module, handling import caching issues."""
    module_name = "app.mcp_server.tools.knowledge"
    if module_name not in sys.modules:
        importlib.import_module(module_name)
    return sys.modules[module_name]


class TestSilentExitTool:
    """Tests for silent_exit tool."""

    def test_silent_exit_returns_marker(self):
        """Test that silent_exit returns the correct marker without token_info."""
        module = get_silent_exit_module()
        # When token_info is None, no database access is needed
        result = module.silent_exit(reason="test reason")
        parsed = json.loads(result)

        assert parsed["__silent_exit__"] is True
        assert parsed["reason"] == "test reason"

    def test_silent_exit_empty_reason(self):
        """Test silent_exit with empty reason."""
        module = get_silent_exit_module()
        # When token_info is None, no database access is needed
        result = module.silent_exit()
        parsed = json.loads(result)

        assert parsed["__silent_exit__"] is True
        assert parsed["reason"] == ""

    def test_silent_exit_with_token_info(self):
        """Test silent_exit with token info - verifies marker is returned."""
        module = get_silent_exit_module()

        token_info = TaskTokenInfo(
            task_id=123,
            subtask_id=456,
            user_id=789,
            user_name="testuser",
        )

        # Use object patching instead of string-based patching
        original_func = module._update_subtask_silent_exit
        mock_update = MagicMock()
        module._update_subtask_silent_exit = mock_update

        try:
            result = module.silent_exit(reason="completed", token_info=token_info)

            # Should attempt to update the database
            mock_update.assert_called_once_with(456, "completed")

            parsed = json.loads(result)
            assert parsed["__silent_exit__"] is True
            assert parsed["reason"] == "completed"
        finally:
            # Restore original function
            module._update_subtask_silent_exit = original_func


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


class TestKnowledgeTool:
    """Tests for knowledge MCP tools."""

    def test_knowledge_mcp_tools_registry_contains_registered_tools(self):
        """Test that the backward-compatible tool registry is built for the knowledge server."""
        module = get_knowledge_module()

        assert "wegent_kb_list_knowledge_bases" in module.KNOWLEDGE_MCP_TOOLS
        assert "wegent_kb_list_documents" in module.KNOWLEDGE_MCP_TOOLS
        assert "wegent_kb_read_document_content" in module.KNOWLEDGE_MCP_TOOLS

    def test_knowledge_mcp_tools_aliases_exist(self):
        """Test that backward-compatible aliases are registered for renamed tools."""
        module = get_knowledge_module()

        # Aliases for old tool names should exist
        assert "list_knowledge_bases" in module.KNOWLEDGE_MCP_TOOLS
        assert "list_documents" in module.KNOWLEDGE_MCP_TOOLS
        assert "read_document_content" in module.KNOWLEDGE_MCP_TOOLS
        assert "create_knowledge_base" in module.KNOWLEDGE_MCP_TOOLS
        assert "create_document" in module.KNOWLEDGE_MCP_TOOLS
        assert "update_document_content" in module.KNOWLEDGE_MCP_TOOLS
        assert "search_knowledge_base" in module.KNOWLEDGE_MCP_TOOLS

        # Aliases should point to the same function as the new names
        assert (
            module.KNOWLEDGE_MCP_TOOLS["list_knowledge_bases"]["func"]
            == module.KNOWLEDGE_MCP_TOOLS["wegent_kb_list_knowledge_bases"]["func"]
        )
        assert (
            module.KNOWLEDGE_MCP_TOOLS["list_documents"]["func"]
            == module.KNOWLEDGE_MCP_TOOLS["wegent_kb_list_documents"]["func"]
        )

    def test_read_document_content_returns_orchestrator_payload(self):
        """Test that read_document_content returns the orchestrator payload."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = object()
        mock_session = MagicMock()
        mock_result = MagicMock(
            document_id=9,
            name="roadmap",
            content="abcd",
            total_length=10,
            offset=0,
            returned_length=4,
            has_more=True,
            kb_id=77,
        )
        expected_payload = {
            "document_id": 9,
            "name": "roadmap",
            "content": "abcd",
            "total_length": 10,
            "offset": 0,
            "returned_length": 4,
            "has_more": True,
            "kb_id": 77,
        }
        mock_result.model_dump.return_value = expected_payload

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(module, "_get_user_from_token", return_value=mock_user),
            patch.object(
                module.knowledge_orchestrator,
                "read_document_content",
                return_value=mock_result,
            ) as mock_read,
        ):
            result = module.read_document_content(
                token_info=token_info,
                document_id=9,
                offset=0,
                limit=4,
            )

        assert result == expected_payload
        mock_read.assert_called_once_with(
            db=mock_session,
            user=mock_user,
            document_id=9,
            offset=0,
            limit=4,
        )
        mock_session.close.assert_called_once()

    def test_read_document_content_returns_error_dict_for_validation_failure(self):
        """Test that read_document_content converts validation failures to error dicts."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = object()
        mock_session = MagicMock()

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(module, "_get_user_from_token", return_value=mock_user),
            patch.object(
                module.knowledge_orchestrator,
                "read_document_content",
                side_effect=ValueError("limit must be greater than 0"),
            ),
        ):
            result = module.read_document_content(
                token_info=token_info,
                document_id=9,
                offset=0,
                limit=0,
            )

        assert result == {"error": "limit must be greater than 0"}
        mock_session.close.assert_called_once()

    def test_read_document_content_returns_error_dict_for_unexpected_failure(self):
        """Test that read_document_content converts unexpected failures to error dicts."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = object()
        mock_session = MagicMock()

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(module, "_get_user_from_token", return_value=mock_user),
            patch.object(
                module.knowledge_orchestrator,
                "read_document_content",
                side_effect=RuntimeError("boom"),
            ),
        ):
            result = module.read_document_content(
                token_info=token_info,
                document_id=9,
            )

        assert result == {"error": "boom"}
        mock_session.close.assert_called_once()

    def test_read_document_content_uses_shared_default_limit_constant(self):
        """Test that read_document_content reuses the shared default limit constant."""
        module = get_knowledge_module()
        target = getattr(
            module.read_document_content,
            "__wrapped__",
            module.read_document_content,
        )
        default_limit = inspect.signature(target).parameters["limit"].default

        assert default_limit == module.MAX_DOCUMENT_READ_LIMIT

    def test_update_document_content_description_mentions_editable_text_files(self):
        """Tool description should reflect support for editable text file documents."""
        module = get_knowledge_module()

        tool_info = module.update_document_content._mcp_tool_info

        assert "TEXT type documents" not in tool_info["description"]
        assert "txt" in tool_info["description"]
        assert "md" in tool_info["description"]
