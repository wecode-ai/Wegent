# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for resuming Claude Code deferred interactive forms."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.claude_code.deferred_mcp_proxy import (
    build_interactive_form_answer_payload,
    create_interactive_form_answer_query,
)
from shared.models.execution import ExecutionRequest
from shared.status import TaskStatus


def _create_mock_emitter():
    emitter = MagicMock()
    emitter.in_progress = AsyncMock()
    emitter.start = AsyncMock()
    emitter.done = AsyncMock()
    emitter.error = AsyncMock()
    emitter.text_delta = AsyncMock()
    return emitter


def _create_agent_for_query_test(
    *,
    tmp_path,
    prompt,
    interactive_form_answer=None,
):
    task_data = ExecutionRequest(
        task_id=12345,
        subtask_id=67890,
        prompt=prompt,
        bot=[{"id": 987, "name": "developer-bot", "shell_type": "ClaudeCode"}],
        interactive_form_answer=interactive_form_answer,
    )
    agent = ClaudeCodeAgent(task_data, _create_mock_emitter())
    agent.options = {"cwd": str(tmp_path)}
    agent.state_manager = SimpleNamespace(task_data=task_data)
    agent.client = SimpleNamespace(query=AsyncMock())
    agent.task_state_manager = SimpleNamespace(
        is_cancelled=MagicMock(return_value=False),
        set_state=MagicMock(),
    )
    agent._create_and_connect_client = AsyncMock()
    agent._auto_close_session = AsyncMock()
    return agent


@pytest.mark.asyncio
async def test_interactive_form_answer_query_sends_tool_result_for_deferred_call():
    answer = {
        "type": "interactive_form_question",
        "tool_use_id": "tool-1",
        "answers": {"target": ["readme"], "scope": "all"},
        "success": True,
        "status": "answered",
        "message": "User answered the form.",
    }

    messages = []
    async for message in create_interactive_form_answer_query(answer):
        messages.append(message)

    assert messages == [
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool-1",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    '{"type": "interactive_form_question", '
                                    '"tool_use_id": "tool-1", '
                                    '"answers": {"target": ["readme"], '
                                    '"scope": "all"}, "success": true, '
                                    '"status": "answered", '
                                    '"message": "User answered the form."}'
                                ),
                            }
                        ],
                        "is_error": False,
                    }
                ],
            },
            "parent_tool_use_id": "tool-1",
            "tool_use_result": {
                "tool_use_id": "tool-1",
                "content": {
                    "type": "interactive_form_question",
                    "tool_use_id": "tool-1",
                    "answers": {"target": ["readme"], "scope": "all"},
                    "success": True,
                    "status": "answered",
                    "message": "User answered the form.",
                },
                "is_error": False,
            },
        }
    ]


def test_interactive_form_answer_payload_excludes_runtime_metadata():
    payload = build_interactive_form_answer_payload(
        {
            "type": "interactive_form_question",
            "tool_use_id": "tool-1",
            "answers": {"scope": "all"},
            "success": True,
            "status": "answered",
            "message": "User answered the form.",
            "auth_token": "secret-token",
            "backend_url": "https://backend.example",
            "workspace": {"repository": {"gitUrl": "https://example/repo.git"}},
        }
    )

    assert payload == {
        "type": "interactive_form_question",
        "tool_use_id": "tool-1",
        "answers": {"scope": "all"},
        "success": True,
        "status": "answered",
        "message": "User answered the form.",
    }


def test_interactive_form_answer_payload_rejects_synthetic_ask_id():
    payload = build_interactive_form_answer_payload(
        {
            "type": "interactive_form_question",
            "ask_id": "ask_6683514",
            "tool_use_id": "ask_6683514",
            "answers": {"target": "readme"},
        }
    )

    assert payload is None


@pytest.mark.asyncio
async def test_agent_sends_interactive_form_answer_as_tool_result(tmp_path):
    answer = {
        "type": "interactive_form_question",
        "tool_use_id": "tool-1",
        "answers": {"scope": "all"},
        "success": True,
        "status": "answered",
        "message": "User answered the form.",
    }
    agent = _create_agent_for_query_test(
        tmp_path=tmp_path,
        prompt="This should not be sent as the follow-up prompt",
        interactive_form_answer=answer,
    )

    with patch(
        "executor.agents.claude_code.claude_code_agent.process_response",
        new=AsyncMock(return_value=TaskStatus.COMPLETED),
    ):
        result = await agent._async_execute()

    assert result == TaskStatus.COMPLETED
    agent.client.query.assert_awaited_once()
    query_arg = agent.client.query.await_args.args[0]
    messages = [message async for message in query_arg]

    assert messages[0]["message"]["content"][0]["type"] == "tool_result"
    assert messages[0]["message"]["content"][0]["tool_use_id"] == "tool-1"
    assert (
        "This should not be sent"
        not in messages[0]["message"]["content"][0]["content"][0]["text"]
    )
    assert agent.client.query.await_args.kwargs["session_id"] == agent.session_id


@pytest.mark.asyncio
async def test_agent_keeps_normal_follow_up_on_prompt_channel(tmp_path):
    agent = _create_agent_for_query_test(
        tmp_path=tmp_path,
        prompt="Continue with the implementation",
    )

    with patch(
        "executor.agents.claude_code.claude_code_agent.process_response",
        new=AsyncMock(return_value=TaskStatus.COMPLETED),
    ):
        result = await agent._async_execute()

    assert result == TaskStatus.COMPLETED
    agent.client.query.assert_awaited_once()
    query_arg = agent.client.query.await_args.args[0]

    assert isinstance(query_arg, str)
    assert "Continue with the implementation" in query_arg
    assert "Current working directory:" in query_arg
