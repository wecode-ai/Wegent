# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Phase 2a: authoritative-state persistence across terminal paths.

Task 1 is a feasibility gate: prove that a real ``create_react_agent`` with a
compacting ``pre_model_hook`` and a forced ``GraphRecursionError`` yields the
post-compaction authoritative state via ``aget_state`` under
``durability="exit"`` while keeping a single checkpoint.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.prebuilt import create_react_agent

SUMMARY_FLAG = "summary_compacted"


@tool
def _probe(query: str) -> str:
    """Probe tool that echoes its query."""
    return f"result::{query}"


class _LoopingModel(BaseChatModel):
    """Emits a fresh tool call on every call, so the ReAct loop never ends."""

    call_count: int = 0

    @property
    def _llm_type(self) -> str:
        return "looping"

    def bind_tools(self, tools, **kwargs):  # create_react_agent calls this
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.call_count += 1
        n = self.call_count
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content=f"turn {n}",
                        tool_calls=[
                            {
                                "name": "_probe",
                                "args": {"query": f"q{n}"},
                                "id": f"t{n}",
                            }
                        ],
                    )
                )
            ]
        )


class _CompactOnSecond:
    """pre_model_hook that compacts on its 2nd invocation, like the guard."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, state):
        self.calls += 1
        msgs = state["messages"]
        if self.calls == 2:
            summary = HumanMessage(
                content="[COMPACT SUMMARY] x",
                additional_kwargs={SUMMARY_FLAG: True},
                id="s-1",
            )
            removals = [RemoveMessage(id=m.id) for m in msgs if m.id]
            return {"messages": [*removals, summary]}
        return {}


@pytest.mark.asyncio
async def test_exit_durability_yields_post_compaction_state_after_recursion():
    saver = InMemorySaver()
    agent = create_react_agent(
        model=_LoopingModel(),
        tools=[_probe],
        checkpointer=saver,
        pre_model_hook=_CompactOnSecond(),
    )
    config = {"configurable": {"thread_id": str(uuid4())}, "recursion_limit": 8}

    with pytest.raises(GraphRecursionError):
        async for _ in agent.astream_events(
            {"messages": [HumanMessage(content="q0", id="u1")]},
            config,
            version="v2",
            durability="exit",
        ):
            pass

    snap = await agent.aget_state(config)
    msgs = snap.values["messages"]

    # Summary checkpoint survives the error.
    assert any(m.additional_kwargs.get(SUMMARY_FLAG) for m in msgs)
    # Post-compaction completed tool pair (t2) survives.
    assert any(getattr(m, "tool_call_id", None) == "t2" for m in msgs)
    # Pre-compaction content was actually REPLACED, not merely appended to:
    # the input user and the pre-compaction tool pair are gone. This proves we
    # read the post-replacement authoritative state, not just "summary present".
    assert all(m.id != "u1" for m in msgs)
    assert not any(getattr(m, "tool_call_id", None) == "t1" for m in msgs)
    # exit durability => a single committed checkpoint, not one per super-step.
    assert len(list(saver.list(config))) == 1


def test_build_agent_attaches_request_local_checkpointer():
    from chat_shell.agents.graph_builder import LangGraphAgentBuilder

    builder = LangGraphAgentBuilder(llm=_LoopingModel())
    agent = builder._build_agent()

    assert builder._checkpointer is not None  # always present now
    assert agent.checkpointer is builder._checkpointer


@pytest.mark.asyncio
async def test_stream_tokens_injects_unique_thread_and_exit_durability(monkeypatch):
    from chat_shell.agents.graph_builder import LangGraphAgentBuilder

    captured: list[dict] = []

    class _EmptySnap:
        values: dict = {"messages": []}

    class _FakeAgent:
        checkpointer = object()

        async def astream_events(
            self, _input, config=None, version=None, durability=None
        ):
            captured.append({"config": config, "durability": durability})
            for _ in []:  # empty async generator
                yield

        async def aget_state(self, _config):
            return _EmptySnap()

    builder = LangGraphAgentBuilder(llm=_LoopingModel())
    monkeypatch.setattr(builder, "_build_agent", lambda: _FakeAgent())

    for _ in range(2):
        async for _token in builder.stream_tokens(
            messages=[{"role": "user", "content": "hi"}]
        ):
            pass

    assert len(captured) == 2
    assert all(c["durability"] == "exit" for c in captured)
    t0 = captured[0]["config"]["configurable"]["thread_id"]
    t1 = captured[1]["config"]["configurable"]["thread_id"]
    assert t0 and t1 and t0 != t1  # present and unique per turn


def test_finalize_turn_history_sets_all_three_fields_atomically():
    from langchain_core.messages import ToolMessage

    from chat_shell.agents.graph_builder import LangGraphAgentBuilder
    from chat_shell.agents.turn_context import TurnExecutionContext

    builder = LangGraphAgentBuilder(llm=_LoopingModel())
    # Authoritative post-compaction state: input "u1" already removed; the
    # retained clone / summary / suffix carry fresh ids (not in original_input_ids).
    state = [
        HumanMessage(
            content="retained",
            additional_kwargs={"checkpoint_retained": True},
            id="r1",
        ),
        HumanMessage(
            content="[COMPACT SUMMARY] s",
            additional_kwargs={"compacted": True, "summary_compacted": True},
            id="s1",
        ),
        AIMessage(
            content="",
            tool_calls=[{"id": "t2", "name": "_probe", "args": {}}],
            id="a2",
        ),
        ToolMessage(content="ok", tool_call_id="t2", name="_probe", id="tm2"),
        AIMessage(content="final answer", id="a3"),
    ]
    ctx = TurnExecutionContext(
        original_input_ids=frozenset({"u1"}), current_thread_id="root"
    )

    builder._finalize_turn_history(state, ctx, "normal_completion")

    chain = builder._last_messages_chain
    assert [c["role"] for c in chain] == [
        "user",
        "user",
        "assistant",
        "tool",
        "assistant",
    ]
    assert chain[0]["additional_kwargs"]["checkpoint_retained"] is True
    assert chain[1]["additional_kwargs"]["summary_compacted"] is True
    assert chain[3]["tool_call_id"] == "t2"
    assert builder._last_termination_reason == "normal_completion"
    assert len(builder._last_live_state_messages) == len(state)


@pytest.mark.asyncio
async def test_normal_completion_persists_from_aget_state(monkeypatch):
    from langchain_core.messages import ToolMessage

    from chat_shell.agents.graph_builder import LangGraphAgentBuilder

    # Authoritative post-compaction state the checkpointer would return: input
    # user already replaced by summary; post-compaction tool pair + final answer.
    authoritative = [
        HumanMessage(
            content="[COMPACT SUMMARY] s",
            additional_kwargs={"compacted": True, "summary_compacted": True},
            id="s1",
        ),
        AIMessage(
            content="",
            tool_calls=[{"id": "t2", "name": "_probe", "args": {}}],
            id="a2",
        ),
        ToolMessage(content="ok", tool_call_id="t2", name="_probe", id="tm2"),
        AIMessage(content="done", id="a3"),
    ]

    class _Snap:
        values = {"messages": authoritative}

    class _FakeAgent:
        checkpointer = object()

        async def astream_events(
            self, _input, config=None, version=None, durability=None
        ):
            for _ in []:  # complete immediately, no events
                yield

        async def aget_state(self, _config):
            return _Snap()

    builder = LangGraphAgentBuilder(llm=_LoopingModel())
    monkeypatch.setattr(builder, "_build_agent", lambda: _FakeAgent())

    async for _token in builder.stream_tokens(
        messages=[{"role": "user", "content": "hi"}]
    ):
        pass

    chain = builder._last_messages_chain
    # Persisted from the authoritative state: summary marker + post-compaction
    # tool pair + final assistant, not just the last message.
    assert any(c.get("additional_kwargs", {}).get("summary_compacted") for c in chain)
    assert any(c["role"] == "tool" for c in chain)
    assert chain[-1]["role"] == "assistant"
    assert builder._last_termination_reason == "normal_completion"
