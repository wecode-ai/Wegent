# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Claude Code deferred MCP proxy handling."""

from types import SimpleNamespace

import pytest

from executor.agents.claude_code.deferred_mcp_proxy import (
    build_pre_tool_use_defer_response,
    is_deferred_user_input_result,
    parse_mcp_tool_name,
    proxy_deferred_mcp_tool,
)


def test_parse_mcp_tool_name_from_claude_code_name():
    parsed = parse_mcp_tool_name(
        "mcp__interactive_wegent-interactive-form-question__interactive_form_question"
    )

    assert parsed is not None
    assert parsed.server_name == "interactive_wegent-interactive-form-question"
    assert parsed.tool_name == "interactive_form_question"


def test_pre_tool_use_defer_response_uses_sdk_permission_decision():
    assert build_pre_tool_use_defer_response() == {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "defer",
        }
    }


def test_detects_deferred_user_input_result_from_mcp_text_content():
    result = {
        "content": [
            {
                "type": "text",
                "text": '{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response"}',
            }
        ]
    }

    assert is_deferred_user_input_result(result)


@pytest.mark.asyncio
async def test_proxy_deferred_mcp_tool_calls_configured_mcp_server(monkeypatch):
    calls = {}

    class FakeHttpClient:
        async def __aenter__(self):
            return ("read", "write", lambda: "session-id")

        async def __aexit__(self, exc_type, exc, tb):
            return None

    class FakeSession:
        def __init__(self, read_stream, write_stream):
            calls["streams"] = (read_stream, write_stream)

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def initialize(self):
            calls["initialized"] = True

        async def call_tool(self, name, arguments):
            calls["tool"] = (name, arguments)
            return SimpleNamespace(
                content=[
                    SimpleNamespace(
                        type="text",
                        text='{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response", "ask_id": "ask_1"}',
                    )
                ],
                isError=False,
            )

    def fake_streamablehttp_client(**kwargs):
        calls["http"] = kwargs
        return FakeHttpClient()

    monkeypatch.setattr(
        "executor.agents.claude_code.deferred_mcp_proxy.streamablehttp_client",
        fake_streamablehttp_client,
    )
    monkeypatch.setattr(
        "executor.agents.claude_code.deferred_mcp_proxy.ClientSession",
        FakeSession,
    )

    result = await proxy_deferred_mcp_tool(
        deferred_tool_use=SimpleNamespace(
            id="tool-1",
            name="mcp__interactive_wegent-interactive-form-question__interactive_form_question",
            input={"questions": [{"id": "q", "question": "Q?"}]},
        ),
        mcp_servers={
            "interactive_wegent-interactive-form-question": {
                "type": "http",
                "url": "http://backend/mcp/interactive-form-question/sse",
                "headers": {"Authorization": "Bearer task-token"},
                "timeout": 12,
            }
        },
    )

    assert calls["http"]["url"] == "http://backend/mcp/interactive-form-question/sse"
    assert calls["http"]["headers"] == {"Authorization": "Bearer task-token"}
    assert calls["initialized"] is True
    assert calls["tool"] == (
        "interactive_form_question",
        {"questions": [{"id": "q", "question": "Q?"}]},
    )
    assert result.is_deferred_user_input is True
    assert result.tool_result["content"][0]["type"] == "text"
