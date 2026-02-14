# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP tool registry."""

import json
from typing import Optional
from unittest.mock import MagicMock, patch

import pytest
from pydantic import BaseModel

from app.mcp_server.context import MCPRequestContext, get_mcp_context, set_mcp_context
from app.mcp_server.tool_registry import (
    _serialize_result,
    _set_function_signature,
)

# ============== Fixture Models (not starting with "Test" to avoid pytest warning) ==============


class ResponseFixture(BaseModel):
    """Response model for testing."""

    id: int
    name: str


# ============== Serialize Result Tests ==============


class TestSerializeResult:
    """Tests for _serialize_result function."""

    def test_serialize_none(self):
        """Test serializing None result."""
        result = _serialize_result(None)
        parsed = json.loads(result)
        assert parsed == {"success": True}

    def test_serialize_string(self):
        """Test serializing string result."""
        result = _serialize_result("plain string")
        assert result == "plain string"

    def test_serialize_pydantic_model(self):
        """Test serializing Pydantic model."""
        model = ResponseFixture(id=1, name="test")
        result = _serialize_result(model)
        parsed = json.loads(result)
        assert parsed["id"] == 1
        assert parsed["name"] == "test"

    def test_serialize_dict(self):
        """Test serializing dict."""
        data = {"key": "value", "number": 42}
        result = _serialize_result(data)
        parsed = json.loads(result)
        assert parsed == data


class TestSetFunctionSignature:
    """Tests for _set_function_signature function."""

    def test_sets_signature(self):
        """Test that function signature is set correctly."""
        import inspect

        def test_func(**kwargs):
            pass

        params = [
            {"name": "name", "type": "string", "required": True},
            {"name": "count", "type": "integer", "required": False, "default": 10},
        ]

        _set_function_signature(test_func, params)

        sig = inspect.signature(test_func)
        param_names = list(sig.parameters.keys())

        assert "name" in param_names
        assert "count" in param_names

        name_param = sig.parameters["name"]
        assert name_param.annotation is str
        assert name_param.default is inspect.Parameter.empty

        count_param = sig.parameters["count"]
        assert count_param.default == 10


class TestMCPContext:
    """Tests for MCP context management."""

    def test_set_and_get_context(self):
        """Test setting and getting MCP context."""
        from app.mcp_server.auth import TaskTokenInfo

        token_info = TaskTokenInfo(task_id=1, subtask_id=2, user_id=3, user_name="test")

        ctx = MCPRequestContext(
            token_info=token_info,
            tool_name="test_tool",
            server_name="knowledge",
        )

        token = set_mcp_context(ctx)
        try:
            retrieved_ctx = get_mcp_context()
            assert retrieved_ctx is not None
            assert retrieved_ctx.token_info.user_id == 3
            assert retrieved_ctx.tool_name == "test_tool"
        finally:
            from app.mcp_server.context import reset_mcp_context

            reset_mcp_context(token)

    def test_context_returns_none_when_not_set(self):
        """Test that context returns None when not set."""
        from app.mcp_server.context import _mcp_context

        # Save original token
        original_token = _mcp_context.set(None)
        try:
            # Now context should return None
            ctx = get_mcp_context()
            assert ctx is None
        finally:
            # Restore original context
            _mcp_context.reset(original_token)
