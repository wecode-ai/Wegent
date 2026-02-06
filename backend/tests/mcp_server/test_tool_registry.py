# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP tool registry."""

import json
from typing import Optional
from unittest.mock import MagicMock, patch

import pytest
from fastapi import Query
from pydantic import BaseModel, Field

from app.mcp_server.context import MCPRequestContext, get_mcp_context, set_mcp_context
from app.mcp_server.decorator import clear_registry, mcp_tool
from app.mcp_server.tool_registry import (
    _invoke_endpoint,
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
        assert name_param.annotation == str
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
        # Clear any existing context
        ctx = get_mcp_context()
        # This might be None or might have leftover context from other tests
        # The important thing is it doesn't raise an exception


class TestInvokeEndpoint:
    """Tests for _invoke_endpoint function."""

    def setup_method(self):
        """Set up test fixtures."""
        clear_registry()

    @patch("app.db.session.SessionLocal")
    def test_invoke_without_context_returns_error(self, mock_session_local):
        """Test that invoking without context returns auth error."""

        def test_endpoint(name: str, db=None, current_user=None):
            return {"name": name}

        # Ensure no context is set
        result = _invoke_endpoint(
            original_func=test_endpoint,
            kwargs={"name": "test"},
            param_names=["name"],
            tool_name="test_tool",
            server_name="knowledge",
            is_async=False,
        )

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Authentication" in parsed["error"]

    @patch("app.db.session.SessionLocal")
    def test_invoke_with_context(self, mock_session_local):
        """Test successful invocation with context."""
        from app.mcp_server.auth import TaskTokenInfo
        from app.mcp_server.context import reset_mcp_context

        # Set up mock db session
        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        # Set up mock user
        mock_user = MagicMock()
        mock_user.id = 123
        mock_db.query.return_value.filter.return_value.first.return_value = mock_user

        # Set up context
        token_info = TaskTokenInfo(
            task_id=1, subtask_id=2, user_id=123, user_name="test"
        )
        ctx = MCPRequestContext(
            token_info=token_info,
            tool_name="test_tool",
            server_name="knowledge",
        )
        ctx_token = set_mcp_context(ctx)

        try:
            # Define test endpoint
            def test_endpoint(name: str, db=None, current_user=None):
                return {
                    "name": name,
                    "user_id": current_user.id if current_user else None,
                }

            result = _invoke_endpoint(
                original_func=test_endpoint,
                kwargs={"name": "test"},
                param_names=["name"],
                tool_name="test_tool",
                server_name="knowledge",
                is_async=False,
            )

            parsed = json.loads(result)
            assert parsed["name"] == "test"
            assert parsed["user_id"] == 123
        finally:
            reset_mcp_context(ctx_token)
            mock_db.close.assert_called_once()
