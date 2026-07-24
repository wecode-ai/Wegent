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
    # exit durability => a single committed checkpoint, not one per super-step.
    assert len(list(saver.list(config))) == 1
