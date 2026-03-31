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


class TestToolWrapperExecutor:
    """Tests for the async tool_wrapper created inside _register_tool.

    The wrapper must:
    1. Return an authentication error when context is missing.
    2. Run the synchronous tool function in a thread-pool executor (not block event loop).
    3. Inject token_info into call_kwargs.
    4. Only pass declared MCP parameters (strip unknown kwargs).
    5. Serialize the result via _serialize_result.
    6. Catch exceptions and return a JSON error string.
    """

    def _make_tool_info(self, func, name="test_tool", params=None):
        """Build a minimal tool_info dict as produced by the @mcp_tool decorator."""
        return {
            "func": func,
            "name": name,
            "description": "A test tool",
            "parameters": params
            or [{"name": "query", "type": "string", "required": True}],
        }

    def _register_and_extract_wrapper(self, tool_info, server_name="knowledge"):
        """Register tool_info to a mock FastMCP and return the captured wrapper."""
        from app.mcp_server.tool_registry import _register_tool

        captured = {}

        class MockFastMCP:
            def tool(self_inner):
                def decorator(fn):
                    captured["wrapper"] = fn
                    return fn

                return decorator

        _register_tool(MockFastMCP(), tool_info, server_name)
        return captured["wrapper"]

    @pytest.mark.asyncio
    async def test_wrapper_returns_auth_error_when_no_context(self):
        """Wrapper returns JSON auth error when MCP context is absent."""
        from app.mcp_server.context import _mcp_context

        def dummy_tool(**kwargs):
            return {"ok": True}

        wrapper = self._register_and_extract_wrapper(self._make_tool_info(dummy_tool))

        token = _mcp_context.set(None)
        try:
            result = await wrapper(query="hello")
        finally:
            _mcp_context.reset(token)

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Authentication" in parsed["error"]

    @pytest.mark.asyncio
    async def test_wrapper_injects_token_info(self):
        """Wrapper injects token_info from context into the tool call."""
        from app.mcp_server.auth import TaskTokenInfo
        from app.mcp_server.context import (
            MCPRequestContext,
            reset_mcp_context,
            set_mcp_context,
        )

        received_kwargs = {}

        def capture_tool(token_info, query):
            received_kwargs["token_info"] = token_info
            received_kwargs["query"] = query
            return {"captured": True}

        params = [{"name": "query", "type": "string", "required": True}]
        tool_info = self._make_tool_info(capture_tool, params=params)
        wrapper = self._register_and_extract_wrapper(tool_info)

        token_info = TaskTokenInfo(
            task_id=10, subtask_id=20, user_id=30, user_name="alice"
        )
        ctx = MCPRequestContext(
            token_info=token_info, tool_name="test_tool", server_name="knowledge"
        )
        token = set_mcp_context(ctx)
        try:
            result = await wrapper(query="my query")
        finally:
            reset_mcp_context(token)

        parsed = json.loads(result)
        assert parsed.get("captured") is True
        assert received_kwargs["token_info"].user_id == 30
        assert received_kwargs["query"] == "my query"

    @pytest.mark.asyncio
    async def test_wrapper_strips_unknown_kwargs(self):
        """Wrapper only passes declared MCP param names to the tool function."""
        from app.mcp_server.auth import TaskTokenInfo
        from app.mcp_server.context import (
            MCPRequestContext,
            reset_mcp_context,
            set_mcp_context,
        )

        received_kwargs = {}

        def strict_tool(token_info, query):
            received_kwargs.update({"token_info": token_info, "query": query})
            return "ok"

        params = [{"name": "query", "type": "string", "required": True}]
        tool_info = self._make_tool_info(strict_tool, params=params)
        wrapper = self._register_and_extract_wrapper(tool_info)

        token_info = TaskTokenInfo(task_id=1, subtask_id=2, user_id=3, user_name="bob")
        ctx = MCPRequestContext(
            token_info=token_info, tool_name="strict_tool", server_name="test"
        )
        token = set_mcp_context(ctx)
        try:
            # Pass an extra kwarg that is NOT in the MCP param list
            result = await wrapper(query="hello", _unknown_param="should_be_stripped")
        finally:
            reset_mcp_context(token)

        # Result should be the serialized "ok" string — no error means no unexpected param
        assert result == "ok"
        # And the unknown param must NOT have reached the tool
        assert "_unknown_param" not in received_kwargs

    @pytest.mark.asyncio
    async def test_wrapper_catches_exception_and_returns_json_error(self):
        """Wrapper catches tool exceptions and returns a JSON error string."""
        from app.mcp_server.auth import TaskTokenInfo
        from app.mcp_server.context import (
            MCPRequestContext,
            reset_mcp_context,
            set_mcp_context,
        )

        def exploding_tool(token_info, query):
            raise RuntimeError("Something went wrong")

        params = [{"name": "query", "type": "string", "required": True}]
        tool_info = self._make_tool_info(exploding_tool, params=params)
        wrapper = self._register_and_extract_wrapper(tool_info)

        token_info = TaskTokenInfo(task_id=1, subtask_id=2, user_id=3, user_name="test")
        ctx = MCPRequestContext(
            token_info=token_info, tool_name="test", server_name="test"
        )
        token = set_mcp_context(ctx)
        try:
            result = await wrapper(query="boom")
        finally:
            reset_mcp_context(token)

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Something went wrong" in parsed["error"]

    @pytest.mark.asyncio
    async def test_wrapper_runs_sync_tool_in_executor(self):
        """Wrapper executes the sync tool in a thread-pool executor (not inline)."""
        import threading

        from app.mcp_server.auth import TaskTokenInfo
        from app.mcp_server.context import (
            MCPRequestContext,
            reset_mcp_context,
            set_mcp_context,
        )

        main_thread_id = threading.current_thread().ident
        tool_thread_ids = []

        def thread_recording_tool(token_info, query):
            tool_thread_ids.append(threading.current_thread().ident)
            return {"thread": "recorded"}

        params = [{"name": "query", "type": "string", "required": True}]
        tool_info = self._make_tool_info(thread_recording_tool, params=params)
        wrapper = self._register_and_extract_wrapper(tool_info)

        token_info = TaskTokenInfo(task_id=1, subtask_id=2, user_id=3, user_name="test")
        ctx = MCPRequestContext(
            token_info=token_info, tool_name="test", server_name="test"
        )
        token = set_mcp_context(ctx)
        try:
            result = await wrapper(query="test")
        finally:
            reset_mcp_context(token)

        parsed = json.loads(result)
        assert parsed.get("thread") == "recorded"
        # The tool must have run in a DIFFERENT thread (executor thread)
        assert len(tool_thread_ids) == 1
        assert tool_thread_ids[0] != main_thread_id
