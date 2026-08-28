# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from chat_shell.tools.deferred_input import DeferredUserInputExit
from chat_shell.tools.events import (
    _extract_card_result,
    _extract_retrieval_summary,
    create_tool_event_handler,
)


class _State:
    def __init__(self):
        self.blocks = []

    def add_block(self, block):
        self.blocks.append(block)

    def add_sources(self, sources):
        return None

    def add_loaded_skill(self, skill_name):
        return None


def test_extract_card_result_supports_mcp_text_content():
    result = _extract_card_result(
        [{"type": "text", "text": '{"id":"abc","card_type":"video"}'}]
    )

    assert result == {"id": "abc", "card_type": "video"}


class _AgentBuilder:
    def __init__(self, tool_instance):
        self.tool_registry = {"search_docs": tool_instance}
        self.all_tools = [tool_instance]


@pytest.mark.asyncio
async def test_card_result_stores_block_without_tool_name_coupling():
    emitter = AsyncMock()
    tool = SimpleNamespace(
        name="publish_result_card",
        _wegent_tool_protocol="mcp",
        _wegent_mcp_server_label="wegent-cards",
    )
    agent_builder = _AgentBuilder(tool)
    agent_builder.tool_registry = {"publish_result_card": tool}
    state = _State()
    handler = create_tool_event_handler(state, emitter, agent_builder)
    handler(
        "tool_end",
        {
            "run_id": "card-run",
            "tool_use_id": "card-call",
            "name": "publish_result_card",
            "data": {
                "input": {},
                "output": {
                    "id": "card-abc",
                    "card_type": "video_director_generation",
                    "status": "pending",
                    "data": {},
                    "preview_data": {"title": "生成中"},
                },
            },
        },
    )
    await handler.wait_pending()

    emitter.block_created.assert_not_awaited()
    assert state.blocks[0]["id"] == "card-abc"
    assert state.blocks[0]["type"] == "card"
    assert state.blocks[0]["card_status"] == "pending"


def test_extract_retrieval_summary_preserves_provider_source_pairs():
    output = {
        "source_summaries": [
            {
                "provider": "alpha",
                "searched_source_ids": ["same-source"],
                "ignored_source_ids": [],
            },
            {
                "provider": "beta",
                "searched_source_ids": [],
                "ignored_source_ids": ["same-source"],
            },
        ]
    }

    summary = _extract_retrieval_summary("knowledge_base_search", output)

    assert summary == {
        "searched_source_ids": ["same-source"],
        "ignored_source_ids": ["same-source"],
        "searched_sources": [{"provider": "alpha", "source_id": "same-source"}],
        "ignored_sources": [{"provider": "beta", "source_id": "same-source"}],
        "source_statuses": [],
    }


def test_streaming_state_aggregates_retrieval_summary_by_provider_pair():
    from chat_shell.services.streaming.core import StreamingState

    state = StreamingState(task_id=1, subtask_id=2, user_id=3, user_name="tester")
    state.add_retrieval_summary(
        {
            "searched_sources": [{"provider": "alpha", "source_id": "same-source"}],
            "ignored_sources": [{"provider": "beta", "source_id": "same-source"}],
        }
    )
    state.add_retrieval_summary(
        {
            "searched_sources": [{"provider": "beta", "source_id": "same-source"}],
            "ignored_sources": [{"provider": "alpha", "source_id": "same-source"}],
        }
    )

    assert state.get_retrieval_summary() == {
        "searched_source_ids": ["same-source", "same-source"],
        "ignored_source_ids": [],
        "source_statuses": [],
    }


@pytest.mark.asyncio
async def test_mcp_tool_end_error_emits_failed_status():
    emitter = AsyncMock()
    tool = SimpleNamespace(
        name="search_docs",
        _wegent_tool_protocol="mcp",
        _wegent_mcp_server_label="wegent-knowledge",
    )
    agent_builder = _AgentBuilder(tool)
    state = _State()

    handler = create_tool_event_handler(
        state=state,
        emitter=emitter,
        agent_builder=agent_builder,
    )
    error_output = "MCP tool 'search_docs' timed out after 180.0s"
    handler(
        "tool_end",
        {
            "run_id": "run_123",
            "tool_use_id": "mcp_123",
            "name": "search_docs",
            "data": {
                "input": {"query": "timeout"},
                "output": error_output,
            },
        },
    )

    await handler.wait_pending()

    emitter.tool_done.assert_awaited_once_with(
        call_id="mcp_123",
        name="search_docs",
        arguments=None,
        output=error_output,
        tool_protocol="mcp_call",
        server_label="wegent-knowledge",
        status="failed",
        error=error_output,
    )


@pytest.mark.asyncio
async def test_deferred_interactive_form_tool_end_emits_result_then_exits():
    emitter = AsyncMock()
    tool = SimpleNamespace(
        name="interactive_form_question",
        _wegent_tool_protocol="mcp",
        _wegent_mcp_server_label="wegent-interactive-form-question",
    )
    agent_builder = _AgentBuilder(tool)
    state = _State()

    handler = create_tool_event_handler(
        state=state,
        emitter=emitter,
        agent_builder=agent_builder,
    )
    output = {
        "__deferred_user_input__": True,
        "success": True,
        "status": "waiting_for_user_response",
    }

    with pytest.raises(DeferredUserInputExit) as exc_info:
        handler(
            "tool_end",
            {
                "run_id": "run_123",
                "tool_use_id": "mcp_123",
                "name": "interactive_form_question",
                "data": {
                    "input": {"questions": [{"id": "q1", "question": "Q?"}]},
                    "output": output,
                },
            },
        )

    assert str(exc_info.value) == "Waiting for user input"
    assert state.is_deferred_user_input is True
    assert state.deferred_user_input_tool_use_id == "mcp_123"

    await handler.wait_pending()

    emitter.tool_done.assert_awaited_once_with(
        call_id="mcp_123",
        name="interactive_form_question",
        arguments=None,
        output=output,
        tool_protocol="mcp_call",
        server_label="wegent-interactive-form-question",
        status="completed",
        error=None,
    )


@pytest.mark.asyncio
async def test_tool_event_handler_waits_for_pending_emissions() -> None:
    emitter = AsyncMock()
    release = asyncio.Event()

    async def delayed_delta(**kwargs: Any) -> dict[str, Any]:
        await release.wait()
        return kwargs

    emitter.tool_argument_delta.side_effect = delayed_delta
    handler = create_tool_event_handler(_State(), emitter, object())
    handler(
        "tool_argument_delta",
        {
            "call_id": "call-1",
            "arguments_delta": "late",
        },
    )

    waiter = asyncio.create_task(handler.wait_pending())
    await asyncio.sleep(0)
    assert not waiter.done()

    release.set()
    await waiter
    emitter.tool_argument_delta.assert_awaited_once_with(
        call_id="call-1",
        arguments_delta="late",
        arguments_summary=None,
    )
