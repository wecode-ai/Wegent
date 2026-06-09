# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ResultMessage handling of deferred MCP proxy calls."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from claude_agent_sdk.types import DeferredToolUse, ResultMessage

from executor.agents.claude_code.deferred_mcp_proxy import DeferredMcpProxyResult
from executor.agents.claude_code.response_processor import _process_result_message
from shared.status import TaskStatus


@pytest.mark.asyncio
async def test_process_result_message_proxies_deferred_interactive_form(monkeypatch):
    emitted_events = []

    emitter = SimpleNamespace(
        tool_start=AsyncMock(
            side_effect=lambda **kwargs: emitted_events.append(("tool_start", kwargs))
        ),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        error=AsyncMock(),
    )
    emitter.tool_done.side_effect = lambda **kwargs: emitted_events.append(
        ("tool_done", kwargs)
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
    emitter.tool_start.assert_awaited_once()
    tool_start_kwargs = emitter.tool_start.await_args.kwargs
    assert tool_start_kwargs["call_id"] == "tool-1"
    assert tool_start_kwargs["name"] == (
        "mcp__interactive_wegent-interactive-form-question__"
        "interactive_form_question"
    )
    assert tool_start_kwargs["tool_protocol"] == "mcp_call"
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
    assert emitted_events[0][0] == "tool_start"
    assert emitted_events[1][0] == "tool_done"


@pytest.mark.asyncio
async def test_process_result_message_handles_deferred_unavailable_form(
    monkeypatch,
):
    emitter = SimpleNamespace(
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        error=AsyncMock(),
    )
    state_manager = SimpleNamespace(
        task_data=SimpleNamespace(task_id=10, subtask_id=20),
        set_task_status=MagicMock(),
        report_progress=MagicMock(),
    )

    async def fake_proxy_deferred_mcp_tool(*, deferred_tool_use, mcp_servers):
        return DeferredMcpProxyResult(
            tool_use_id=deferred_tool_use.id,
            tool_name=deferred_tool_use.name,
            server_name="interactive_wegent-interactive-form-question",
            tool_result={
                "content": [
                    {
                        "type": "text",
                        "text": '{"__deferred_user_input__": true}',
                    }
                ]
            },
            output_text='{"__deferred_user_input__": true}',
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
        is_error=True,
        num_turns=1,
        session_id="session-1",
        stop_reason="tool_deferred_unavailable",
        usage={"input_tokens": 1},
        deferred_tool_use=DeferredToolUse(
            id="tool-2",
            name=(
                "mcp__interactive_wegent-interactive-form-question__"
                "interactive_form_question"
            ),
            input={"questions": [{"id": "q1", "question": "Question?"}]},
        ),
    )

    result = await _process_result_message(
        msg=msg,
        emitter=emitter,
        state_manager=state_manager,
        mcp_servers={},
    )

    assert result == TaskStatus.COMPLETED
    emitter.tool_start.assert_awaited_once()
    emitter.tool_done.assert_awaited_once()
    emitter.done.assert_awaited_once_with(
        content="",
        usage={"input_tokens": 1},
        stop_reason="tool_deferred_unavailable",
        silent_exit=True,
        silent_exit_reason="waiting_for_user_input",
    )
    emitter.error.assert_not_awaited()


@pytest.mark.asyncio
async def test_process_result_message_retries_invalid_deferred_form(monkeypatch):
    emitter = SimpleNamespace(
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        error=AsyncMock(),
    )
    state_manager = SimpleNamespace(
        task_data=SimpleNamespace(task_id=10, subtask_id=20),
        set_task_status=MagicMock(),
        report_progress=MagicMock(),
    )
    client = SimpleNamespace(query=AsyncMock())

    async def fake_proxy_deferred_mcp_tool(*, deferred_tool_use, mcp_servers):
        return DeferredMcpProxyResult(
            tool_use_id=deferred_tool_use.id,
            tool_name=deferred_tool_use.name,
            server_name="interactive_wegent-interactive-form-question",
            tool_result={
                "content": [
                    {
                        "type": "text",
                        "text": '{"error": "question field required"}',
                    }
                ]
            },
            output_text='{"error": "question field required"}',
            is_deferred_user_input=False,
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
            id="tool-3",
            name=(
                "mcp__interactive_wegent-interactive-form-question__"
                "interactive_form_question"
            ),
            input={
                "questions": [{"id": "q1", "input_type": "single_choice"}],
                "api_key": "super-secret",
            },
        ),
    )

    result = await _process_result_message(
        msg=msg,
        emitter=emitter,
        state_manager=state_manager,
        client=client,
        session_id="session-1",
        deferred_mcp_retry_count=0,
        max_deferred_mcp_retries=2,
        mcp_servers={},
    )

    assert result == "DEFERRED_MCP_RETRY"
    emitter.error.assert_not_awaited()
    state_manager.set_task_status.assert_not_called()
    client.query.assert_awaited_once()
    assert client.query.await_args.kwargs["session_id"] == "session-1"

    retry_messages = [message async for message in client.query.await_args.args[0]]
    tool_result = retry_messages[0]["message"]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result["tool_use_id"] == "tool-3"
    assert tool_result["is_error"] is True
    retry_payload_text = tool_result["content"][0]["text"]
    retry_payload = json.loads(retry_payload_text)
    assert "Call interactive_form_question again" in retry_payload_text
    assert "invalid_arguments" not in retry_payload
    assert "super-secret" not in retry_payload_text


@pytest.mark.asyncio
async def test_process_result_message_reports_simple_error_after_deferred_retries(
    monkeypatch,
):
    emitter = SimpleNamespace(
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        error=AsyncMock(),
    )
    state_manager = SimpleNamespace(
        task_data=SimpleNamespace(task_id=10, subtask_id=20),
        set_task_status=MagicMock(),
        report_progress=MagicMock(),
    )
    client = SimpleNamespace(query=AsyncMock())

    async def fake_proxy_deferred_mcp_tool(*, deferred_tool_use, mcp_servers):
        return DeferredMcpProxyResult(
            tool_use_id=deferred_tool_use.id,
            tool_name=deferred_tool_use.name,
            server_name="interactive_wegent-interactive-form-question",
            tool_result={
                "content": [
                    {
                        "type": "text",
                        "text": '{"error": "question field required"}',
                    }
                ]
            },
            output_text='{"error": "question field required"}',
            is_deferred_user_input=False,
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
            id="tool-4",
            name=(
                "mcp__interactive_wegent-interactive-form-question__"
                "interactive_form_question"
            ),
            input={"questions": [{"id": "q1", "input_type": "single_choice"}]},
        ),
    )

    result = await _process_result_message(
        msg=msg,
        emitter=emitter,
        state_manager=state_manager,
        client=client,
        session_id="session-1",
        deferred_mcp_retry_count=2,
        max_deferred_mcp_retries=2,
        mcp_servers={},
    )

    assert result == TaskStatus.FAILED
    client.query.assert_not_awaited()
    state_manager.report_progress.assert_called_once_with(
        progress=100,
        status=TaskStatus.FAILED.value,
        message="模型给出的表单格式不对",
    )
    emitter.error.assert_awaited_once_with("模型给出的表单格式不对")


@pytest.mark.asyncio
async def test_process_result_message_hides_deferred_proxy_exception(monkeypatch):
    emitter = SimpleNamespace(
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        error=AsyncMock(),
    )
    state_manager = SimpleNamespace(
        task_data=SimpleNamespace(task_id=10, subtask_id=20),
        set_task_status=MagicMock(),
        report_progress=MagicMock(),
    )

    async def fake_proxy_deferred_mcp_tool(*, deferred_tool_use, mcp_servers):
        raise RuntimeError("Deferred MCP proxy failed internally")

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
            id="tool-5",
            name=(
                "mcp__interactive_wegent-interactive-form-question__"
                "interactive_form_question"
            ),
            input={"questions": [{"id": "q1", "question": "Question?"}]},
        ),
    )

    result = await _process_result_message(
        msg=msg,
        emitter=emitter,
        state_manager=state_manager,
        mcp_servers={},
    )

    assert result == TaskStatus.FAILED
    state_manager.report_progress.assert_called_once_with(
        progress=100,
        status=TaskStatus.FAILED.value,
        message="交互式表单生成失败",
    )
    tool_done_kwargs = emitter.tool_done.await_args.kwargs
    assert tool_done_kwargs["output"] == "交互式表单生成失败"
    assert tool_done_kwargs["error"] == "交互式表单生成失败"
    emitter.error.assert_awaited_once_with("交互式表单生成失败")
