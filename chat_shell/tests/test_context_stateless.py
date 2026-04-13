# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for stateless history and tool toggles in chat context."""

from unittest.mock import MagicMock

import pytest

from chat_shell.services.context import ChatContext
from shared.models.execution import ExecutionRequest


@pytest.mark.asyncio
async def test_load_chat_history_uses_request_history_for_stateless_request():
    request = ExecutionRequest(
        stateless=True,
        history=[{"role": "user", "content": "第一条用户消息"}],
        prompt="第二条用户消息",
    )
    context = ChatContext(request)

    history = await context._load_chat_history()

    assert history == [{"role": "user", "content": "第一条用户消息"}]


def test_build_extra_tools_skips_builtin_tools_when_enable_tools_false():
    request = ExecutionRequest(
        enable_tools=False,
        is_subscription=False,
        user_id=1,
        team_id=1,
        timezone="Asia/Shanghai",
        history=[],
    )
    context = ChatContext(request)
    context._load_skill_tool = MagicMock(name="load_skill_tool")
    context._load_skill_tool.name = "load_skill"

    kb_result = MagicMock()
    kb_result.extra_tools = []

    extra_tools = context._build_extra_tools(kb_result, [], ([], []))

    assert extra_tools == []


@pytest.mark.asyncio
async def test_load_chat_history_does_not_restore_request_history_when_limit_zero(
    monkeypatch,
):
    async def _mock_get_chat_history(*args, **kwargs):
        del args, kwargs
        return []

    monkeypatch.setattr("chat_shell.history.get_chat_history", _mock_get_chat_history)

    request = ExecutionRequest(
        stateless=False,
        history_limit=0,
        history=[{"role": "user", "content": "should stay hidden"}],
        prompt="latest prompt",
    )
    context = ChatContext(request)

    history = await context._load_chat_history()

    assert history == []
