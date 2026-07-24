# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from chat_shell.compression.tool_sanitizer import sanitize_tool_pairs


def test_drops_orphan_tool_message_and_unresolved_tool_call():
    msgs = [
        HumanMessage(content="u"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "a", "name": "t", "args": {}},
                {"id": "b", "name": "t", "args": {}},
            ],
        ),
        ToolMessage(content="ok", tool_call_id="a", name="t"),
        ToolMessage(content="orphan", tool_call_id="zzz", name="t"),
    ]

    out = sanitize_tool_pairs(msgs)

    ai = next(m for m in out if isinstance(m, AIMessage))
    assert [tc["id"] for tc in ai.tool_calls] == ["a"]  # unresolved "b" stripped
    tool_ids = [m.tool_call_id for m in out if isinstance(m, ToolMessage)]
    assert tool_ids == ["a"]  # orphan dropped


def test_preserves_fully_paired_sequence_and_order():
    msgs = [
        HumanMessage(content="u"),
        AIMessage(content="", tool_calls=[{"id": "a", "name": "t", "args": {}}]),
        ToolMessage(content="ok", tool_call_id="a", name="t"),
        AIMessage(content="done"),
    ]

    out = sanitize_tool_pairs(msgs)

    assert [type(m).__name__ for m in out] == [
        "HumanMessage",
        "AIMessage",
        "ToolMessage",
        "AIMessage",
    ]
