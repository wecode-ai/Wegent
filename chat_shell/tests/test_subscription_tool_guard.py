# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for subscription tool guards in subscription execution context."""

from types import SimpleNamespace

from chat_shell.services.context import ChatContext
from shared.models.execution import ExecutionRequest


def _build_empty_kb_result() -> SimpleNamespace:
    """Build an empty KB result for _build_extra_tools tests."""
    return SimpleNamespace(extra_tools=[])


def test_build_extra_tools_skips_create_and_preview_for_subscription_context():
    """Subscription context should not expose create/preview subscription tools."""
    request = ExecutionRequest(is_subscription=True, enable_web_search=False)
    context = ChatContext(request)

    extra_tools = context._build_extra_tools(
        kb_result=_build_empty_kb_result(),
        skill_tools=[],
        mcp_result=([], []),
    )
    tool_names = {tool.name for tool in extra_tools}

    assert "create_subscription" not in tool_names
    assert "preview_subscription" not in tool_names


def test_build_extra_tools_keeps_create_and_preview_for_normal_context():
    """Normal chat context should still expose create/preview subscription tools."""
    request = ExecutionRequest(is_subscription=False, enable_web_search=False)
    context = ChatContext(request)

    extra_tools = context._build_extra_tools(
        kb_result=_build_empty_kb_result(),
        skill_tools=[],
        mcp_result=([], []),
    )
    tool_names = {tool.name for tool in extra_tools}

    assert "create_subscription" in tool_names
    assert "preview_subscription" in tool_names
