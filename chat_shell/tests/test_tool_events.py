# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from chat_shell.tools.events import create_tool_event_handler


class _State:
    def add_sources(self, sources):
        return None

    def add_loaded_skill(self, skill_name):
        return None


class _AgentBuilder:
    def __init__(self, tool_instance):
        self.tool_registry = {"search_docs": tool_instance}
        self.all_tools = [tool_instance]


@pytest.mark.asyncio
async def test_mcp_tool_end_error_emits_failed_status(monkeypatch):
    emitter = AsyncMock()
    tool = SimpleNamespace(
        name="search_docs",
        _wegent_tool_protocol="mcp",
        _wegent_mcp_server_label="wegent-knowledge",
    )
    agent_builder = _AgentBuilder(tool)
    state = _State()
    pending = []

    def run_immediately(coro):
        pending.append(asyncio.create_task(coro))

    monkeypatch.setattr("chat_shell.tools.events._run_async", run_immediately)

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

    await asyncio.gather(*pending)

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
