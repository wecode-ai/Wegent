# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for _new_messages_from_state in graph_builder.

This function replaces the fragile count-based slice
``collected[len(lc_messages):]`` used to separate LLM-generated messages
from input messages after a LangGraph run.  The old approach breaks when
UnifiedContextGuard removes history messages via RemoveMessage mid-run:
the count offset drifts, causing the first generated ToolMessage to appear
at index 0 in new_msgs and triggering an InvalidToolMessageSequenceError.
"""

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph.message import add_messages

from chat_shell.agents.graph_builder import _new_messages_from_state


def _assign_ids(*msgs):
    """Assign stable LangGraph IDs to messages (mirrors stream_tokens behaviour)."""
    add_messages([], list(msgs))
    return msgs


def _input_ids(*msgs) -> frozenset[str]:
    _assign_ids(*msgs)
    return frozenset(m.id for m in msgs if m.id)


def _make_ai_with_tool(call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"id": call_id, "name": "search", "args": {"q": "x"}}],
    )


def _make_tool_result(call_id: str) -> ToolMessage:
    return ToolMessage(content="result", tool_call_id=call_id)


class TestNewMessagesFromStateBasic:
    """Basic correctness: no context-guard interference."""

    def test_empty_collected_returns_empty(self):
        assert _new_messages_from_state([], frozenset()) == []
        assert _new_messages_from_state([], frozenset(["id1"])) == []

    def test_empty_input_ids_returns_all_collected(self):
        ai = AIMessage(content="hello")
        result = _new_messages_from_state([ai], frozenset())
        assert result == [ai]

    def test_no_new_messages_returns_empty(self):
        msg = HumanMessage(content="hi")
        ids = _input_ids(msg)
        assert _new_messages_from_state([msg], ids) == []

    def test_simple_text_response_no_tools(self):
        """Normal turn: one user msg in, one AI response out."""
        user = HumanMessage(content="hello")
        ids = _input_ids(user)

        # LLM generates a response (new ID assigned by LangGraph)
        ai = AIMessage(content="hi there")
        add_messages([], [ai])  # simulate LangGraph assigning ID to generated msg

        result = _new_messages_from_state([user, ai], ids)
        assert result == [ai]

    def test_single_tool_call_round_trip(self):
        """One tool call: AIMessage(tool_calls) + ToolMessage."""
        user = HumanMessage(content="search for X")
        ids = _input_ids(user)

        ai_tool = _make_ai_with_tool("call_1")
        tool_result = _make_tool_result("call_1")
        ai_final = AIMessage(content="Found it")
        # Assign IDs to generated messages as LangGraph would
        add_messages([], [ai_tool, tool_result, ai_final])

        state = [user, ai_tool, tool_result, ai_final]
        result = _new_messages_from_state(state, ids)

        assert result == [ai_tool, tool_result, ai_final]

    def test_multiple_tool_calls(self):
        """Three tool call rounds."""
        system = SystemMessage(content="You are helpful")
        user = HumanMessage(content="research X")
        ids = _input_ids(system, user)

        ai1 = _make_ai_with_tool("call_1")
        t1 = _make_tool_result("call_1")
        ai2 = _make_ai_with_tool("call_2")
        t2 = _make_tool_result("call_2")
        ai3 = _make_ai_with_tool("call_3")
        t3 = _make_tool_result("call_3")
        ai_final = AIMessage(content="Done")
        add_messages([], [ai1, t1, ai2, t2, ai3, t3, ai_final])

        state = [system, user, ai1, t1, ai2, t2, ai3, t3, ai_final]
        result = _new_messages_from_state(state, ids)

        assert result == [ai1, t1, ai2, t2, ai3, t3, ai_final]


class TestNewMessagesFromStateContextGuard:
    """Context guard removes history messages mid-run: the core bug scenario.

    When UnifiedContextGuard fires as pre_model_hook and removes K input
    messages, the final LangGraph state is shorter than the original
    lc_messages count.  The old ``collected[len(lc_messages):]`` slice
    skips K generated messages; the ID-based approach is unaffected.
    """

    def test_guard_removes_one_history_message_before_first_llm_call(self):
        """Reproduces the exact production failure for task 5906037.

        - Input: [sys, hist1, hist2, user_current]  (4 msgs, N=4)
        - Guard fires before first LLM call, removes hist1
        - State after guard: [sys, hist2, user_current]
        - LLM generates: AIMessage(tool_calls), ToolMessage, FinalAIMessage
        - Final state: [sys, hist2, user_current, AI_tc, TM, AI_final]  (6 msgs)

        Old approach: collected[4:] = [TM, AI_final]  -- WRONG (misses AI_tc)
        New approach: ID filter returns [AI_tc, TM, AI_final]  -- CORRECT
        """
        sys_msg = SystemMessage(content="You are helpful")
        hist1 = HumanMessage(content="Turn 1 user")
        hist2 = AIMessage(content="Turn 1 assistant")
        user_current = HumanMessage(content="Turn 2 user")
        ids = _input_ids(sys_msg, hist1, hist2, user_current)  # N=4

        # Guard removed hist1; LLM generated 3 new messages
        ai_tc = _make_ai_with_tool("call_abc")
        tm = _make_tool_result("call_abc")
        ai_final = AIMessage(content="Final answer")
        add_messages([], [ai_tc, tm, ai_final])

        # Final state after guard removal + LLM generation (6 msgs, not 4+3=7)
        final_state = [sys_msg, hist2, user_current, ai_tc, tm, ai_final]

        result = _new_messages_from_state(final_state, ids)

        assert result == [ai_tc, tm, ai_final], (
            "Should include AIMessage(tool_calls) as the first element, "
            "not ToolMessage"
        )
        assert isinstance(result[0], AIMessage) and result[0].tool_calls

    def test_guard_removes_multiple_history_messages(self):
        """Guard removes 3 messages, 2 tool-call rounds in this turn."""
        sys_msg = SystemMessage(content="system")
        h1 = HumanMessage(content="h1")
        h2 = AIMessage(content="h2")
        h3 = HumanMessage(content="h3")
        h4 = AIMessage(content="h4")
        h5 = HumanMessage(content="h5")
        user_current = HumanMessage(content="current")
        ids = _input_ids(sys_msg, h1, h2, h3, h4, h5, user_current)  # N=7

        # Guard removes h1, h2, h3 → 4 input msgs remain
        ai1 = _make_ai_with_tool("call_x")
        t1 = _make_tool_result("call_x")
        ai2 = _make_ai_with_tool("call_y")
        t2 = _make_tool_result("call_y")
        ai_final = AIMessage(content="done")
        add_messages([], [ai1, t1, ai2, t2, ai_final])

        # Final state: 4 remaining inputs + 5 generated
        final_state = [sys_msg, h4, h5, user_current, ai1, t1, ai2, t2, ai_final]

        result = _new_messages_from_state(final_state, ids)

        # Old approach: collected[7:] = [t2, ai_final] — wrong
        assert result == [ai1, t1, ai2, t2, ai_final]
        assert isinstance(result[0], AIMessage) and result[0].tool_calls

    def test_guard_removes_no_messages_behaves_like_old_approach(self):
        """When guard is inactive the result is identical to the old slice."""
        sys_msg = SystemMessage(content="sys")
        user = HumanMessage(content="user")
        ids = _input_ids(sys_msg, user)

        ai_tc = _make_ai_with_tool("call_1")
        tm = _make_tool_result("call_1")
        ai_final = AIMessage(content="final")
        add_messages([], [ai_tc, tm, ai_final])

        final_state = [sys_msg, user, ai_tc, tm, ai_final]

        result = _new_messages_from_state(final_state, ids)

        # Identical to final_state[2:] — same behaviour as old approach
        assert result == [ai_tc, tm, ai_final]

    def test_guard_removes_all_history_leaves_only_user_and_generated(self):
        """Extreme: guard removes everything except user_current."""
        sys_msg = SystemMessage(content="sys")
        h1 = HumanMessage(content="old history")
        h2 = AIMessage(content="old response")
        user_current = HumanMessage(content="new question")
        ids = _input_ids(sys_msg, h1, h2, user_current)

        # Guard removed sys_msg, h1, h2; only user_current remains from input
        ai_tc = _make_ai_with_tool("call_z")
        tm = _make_tool_result("call_z")
        ai_final = AIMessage(content="answer")
        add_messages([], [ai_tc, tm, ai_final])

        final_state = [user_current, ai_tc, tm, ai_final]

        result = _new_messages_from_state(final_state, ids)

        assert result == [ai_tc, tm, ai_final]

    def test_message_without_id_is_treated_as_new(self):
        """A message with id=None is conservatively included in new_msgs."""
        user = HumanMessage(content="user")
        ids = _input_ids(user)

        # Fabricate a generated message that somehow has no ID (defensive edge case)
        ai_no_id = AIMessage(content="response")
        ai_no_id.id = None  # force None

        final_state = [user, ai_no_id]
        result = _new_messages_from_state(final_state, ids)

        assert ai_no_id in result
