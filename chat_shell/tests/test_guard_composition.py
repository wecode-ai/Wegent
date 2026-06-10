# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat_shell.guard.composition — chain_pre_model_hooks (T4)."""

from __future__ import annotations

import pytest
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
)

from chat_shell.guard.composition import chain_pre_model_hooks


class TestChainPreModelHooks:
    def test_requires_at_least_one_hook(self):
        with pytest.raises(ValueError, match="at least one hook"):
            chain_pre_model_hooks()

    @pytest.mark.asyncio
    async def test_single_sync_hook_passthrough(self):
        sync_hook = lambda state: {"messages": [HumanMessage(content="x", id="x-1")]}
        chained = chain_pre_model_hooks(sync_hook)

        result = await chained({"messages": []})
        assert len(result["messages"]) == 1
        assert result["messages"][0].id == "x-1"

    @pytest.mark.asyncio
    async def test_single_async_hook_passthrough(self):
        async def async_hook(state):
            return {"llm_input_messages": [HumanMessage(content="g", id="g-1")]}

        chained = chain_pre_model_hooks(async_hook)
        result = await chained({"messages": []})
        assert len(result["llm_input_messages"]) == 1

    @pytest.mark.asyncio
    async def test_mixed_sync_and_async_run_in_order(self):
        order: list[str] = []

        def sync_first(state):
            order.append("sync")
            return {"messages": [HumanMessage(content="from sync", id="s-1")]}

        async def async_second(state):
            order.append("async")
            # Confirm async hook sees post-sync state.
            assert any(m.id == "s-1" for m in state["messages"])
            return {"llm_input_messages": list(state["messages"])}

        chained = chain_pre_model_hooks(sync_first, async_second)
        result = await chained({"messages": []})

        assert order == ["sync", "async"]
        assert "messages" in result
        assert "llm_input_messages" in result

    @pytest.mark.asyncio
    async def test_messages_from_all_hooks_concatenated(self):
        h1 = lambda state: {"messages": [HumanMessage(content="a", id="a-1")]}
        h2 = lambda state: {"messages": [AIMessage(content="b", id="b-1")]}

        chained = chain_pre_model_hooks(h1, h2)
        result = await chained({"messages": []})

        ids = [m.id for m in result["messages"]]
        assert ids == ["a-1", "b-1"]

    @pytest.mark.asyncio
    async def test_llm_input_messages_from_last_hook_wins(self):
        h1 = lambda state: {"llm_input_messages": [HumanMessage(content="early")]}
        h2 = lambda state: {"llm_input_messages": [HumanMessage(content="late")]}

        chained = chain_pre_model_hooks(h1, h2)
        result = await chained({"messages": []})

        assert len(result["llm_input_messages"]) == 1
        assert result["llm_input_messages"][0].content == "late"

    @pytest.mark.asyncio
    async def test_empty_updates_are_dropped(self):
        chained = chain_pre_model_hooks(
            lambda state: {},
            lambda state: None,
        )
        result = await chained({"messages": [HumanMessage(content="x", id="x-1")]})
        assert result == {}

    @pytest.mark.asyncio
    async def test_remove_message_visible_to_next_hook(self):
        """Hook 2 should see the state after Hook 1's RemoveMessage applied."""
        existing = HumanMessage(content="old", id="old-1")
        h1 = lambda state: {"messages": [RemoveMessage(id="old-1")]}

        async def h2(state):
            ids = [m.id for m in state["messages"]]
            assert "old-1" not in ids
            return {"llm_input_messages": state["messages"]}

        chained = chain_pre_model_hooks(h1, h2)
        result = await chained({"messages": [existing]})

        # Final merged updates carry RemoveMessage so the reducer applies it.
        assert any(isinstance(u, RemoveMessage) for u in result["messages"])
