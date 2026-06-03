# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ResultMessage handling of deferred MCP proxy calls."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from claude_agent_sdk.types import DeferredToolUse, ResultMessage

from executor.agents.claude_code.deferred_mcp_proxy import DeferredMcpProxyResult
from executor.agents.claude_code.response_processor import _process_result_message
from shared.status import TaskStatus


@pytest.mark.asyncio
async def test_process_result_message_proxies_deferred_interactive_form(monkeypatch):
    emitter = SimpleNamespace(
        tool_done=AsyncMock(),
        done=AsyncMock(),
        error=AsyncMock(),
    )
    state_manager = SimpleNamespace(
        task_data=SimpleNamespace(task_id=10, subtask_id=20),
        set_task_status=MagicMock(),
        report_progress=MagicMock(),
    )
    mcp_servers = {
        "interactive_wegent-interactive-form-question": {
            "type": "http",
            "url": "http://backend/mcp/interactive-form-question/sse",
        }
    }

    async def fake_proxy_deferred_mcp_tool(*, deferred_tool_use, mcp_servers):
        assert deferred_tool_use.id == "tool-1"
        assert "interactive_wegent-interactive-form-question" in mcp_servers
        return DeferredMcpProxyResult(
            tool_use_id="tool-1",
            tool_name=deferred_tool_use.name,
            server_name="interactive_wegent-interactive-form-question",
            tool_result={
                "content": [
                    {
                        "type": "text",
                        "text": '{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response"}',
                    }
                ]
            },
            output_text='{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response"}',
            is_deferred_user_input=True,
        )

    monkeypatch.setattr(
        "executor.agents.claude_code.response_processor.proxy_deferred_mcp_tool",
        fake_proxy_deferred_mcp_tool,
    )

    msg = ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="session-1",
        stop_reason="tool_deferred",
        usage={"input_tokens": 1},
        deferred_tool_use=DeferredToolUse(
            id="tool-1",
            name="mcp__interactive_wegent-interactive-form-question__interactive_form_question",
            input={"questions": [{"id": "q1", "question": "Question?"}]},
        ),
    )

    result = await _process_result_message(
        msg=msg,
        emitter=emitter,
        state_manager=state_manager,
        mcp_servers=mcp_servers,
    )

    assert result == TaskStatus.COMPLETED
    emitter.tool_done.assert_awaited_once()
    tool_done_kwargs = emitter.tool_done.await_args.kwargs
    assert tool_done_kwargs["call_id"] == "tool-1"
    assert tool_done_kwargs["tool_protocol"] == "mcp_call"
    assert (
        tool_done_kwargs["server_label"]
        == "interactive_wegent-interactive-form-question"
    )
    emitter.done.assert_awaited_once_with(
        content="",
        usage={"input_tokens": 1},
        stop_reason="tool_deferred",
        silent_exit=True,
        silent_exit_reason="waiting_for_user_input",
    )
    emitter.error.assert_not_awaited()
