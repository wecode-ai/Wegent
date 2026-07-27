# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import dataclasses

import pytest

from chat_shell.agents.turn_context import TurnExecutionContext


def test_retry_inherits_input_ids_and_takes_new_thread():
    ctx = TurnExecutionContext(
        original_input_ids=frozenset({"u1"}), current_thread_id="root"
    )

    child = ctx.with_retry("retry-1")

    assert child.original_input_ids == frozenset({"u1"})  # inherited, unchanged
    assert child.truncation_retry_count == 1
    assert child.current_thread_id == "retry-1"  # child owns its own thread
    assert ctx.current_thread_id == "root"  # parent unchanged


def test_nested_retries_increment_and_own_their_thread():
    ctx = TurnExecutionContext(
        original_input_ids=frozenset({"u1"}), current_thread_id="root"
    )

    grandchild = ctx.with_retry("retry-1").with_retry("retry-2")

    assert grandchild.truncation_retry_count == 2
    assert grandchild.current_thread_id == "retry-2"
    assert grandchild.original_input_ids == frozenset({"u1"})


def test_context_is_immutable():
    ctx = TurnExecutionContext(
        original_input_ids=frozenset({"u1"}), current_thread_id="root"
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        ctx.current_thread_id = "mutated"  # type: ignore[misc]
