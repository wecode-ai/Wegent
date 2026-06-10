# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Composition utilities for LangGraph ``pre_model_hook`` callables.

LangGraph's ``create_react_agent`` accepts a single ``pre_model_hook``. When
multiple subsystems each want to participate (e.g., the unified context guard
and the guidance consumer), they must be combined into one hook.

The chained hook:

* runs the supplied hooks **in order**, so each subsequent hook observes the
  prior hooks' state mutations;
* tolerates a mix of sync and async hooks transparently;
* concatenates ``messages`` updates from every hook (in order);
* keeps the LAST hook's ``llm_input_messages`` if any hook supplied one.

Order matters. Place hooks that mutate state (e.g., the budget guard) BEFORE
hooks that only override the LLM's input list (e.g., guidance injection) so the
latter sees post-mutation state.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from langgraph.graph.message import add_messages

PreModelHook = Callable[[dict[str, Any]], Any]


async def _invoke(hook: PreModelHook, state: dict[str, Any]) -> dict[str, Any]:
    """Call a hook that may be sync or async; always return its dict update."""
    result = hook(state)
    if inspect.isawaitable(result):
        result = await result
    return result or {}


def chain_pre_model_hooks(
    *hooks: PreModelHook,
) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    """Compose multiple ``pre_model_hook`` callables into one async hook.

    Hooks fire in the order given. Each hook sees a state where prior hooks'
    ``messages`` updates have already been applied via the ``add_messages``
    reducer. ``llm_input_messages`` is forwarded from the last hook that
    produced one (so place the guidance-style hook last).
    """
    if not hooks:
        raise ValueError("chain_pre_model_hooks requires at least one hook")

    async def chained(state: dict[str, Any]) -> dict[str, Any]:
        current_state = dict(state)
        accumulated_messages: list[Any] = []
        last_llm_input: Any = None

        for hook in hooks:
            update = await _invoke(hook, current_state)

            if not update:
                continue

            if "messages" in update:
                hook_updates = update["messages"]
                accumulated_messages.extend(hook_updates)
                # Roll the state forward so the next hook sees the mutation.
                current_state = {
                    **current_state,
                    "messages": add_messages(
                        current_state.get("messages", []), hook_updates
                    ),
                }

            if "llm_input_messages" in update:
                last_llm_input = update["llm_input_messages"]

        merged: dict[str, Any] = {}
        if accumulated_messages:
            merged["messages"] = accumulated_messages
        if last_llm_input is not None:
            merged["llm_input_messages"] = last_llm_input
        return merged

    return chained
