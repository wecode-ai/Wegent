# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from chat_shell.compression.context_metrics import (
    PHASE_AFTER_TOOL_END,
    PHASE_BUILD_MESSAGES,
    PHASE_FINAL,
    ContextMetricsSnapshot,
    ContextMetricsTracker,
    calculate_context_metrics,
    should_emit_status_update,
)


def _metrics_fn(messages):
    return calculate_context_metrics(
        messages,
        model_id="gpt-4o",
        model_type="openai",
        model_config={
            "context_window": 800,
            "max_output_tokens": 100,
        },
    )


def test_calculate_context_metrics_uses_model_config_limits():
    snapshot = calculate_context_metrics(
        [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Summarize this file."},
        ],
        model_id="gpt-4o",
        model_type="openai",
        model_config={
            "context_window": 32000,
            "max_output_tokens": 4000,
        },
    )

    assert snapshot.context_window == 32000
    assert snapshot.reserved_output_tokens == 4000
    assert snapshot.available_input_tokens == 28000
    assert snapshot.used_input_tokens > 0
    assert snapshot.remaining_input_tokens < 28000
    assert snapshot.display_remaining_tokens < 32000


def test_should_emit_status_update_throttles_same_bucket():
    previous = ContextMetricsSnapshot(
        context_window=1000,
        reserved_output_tokens=100,
        available_input_tokens=900,
        used_input_tokens=480,
        remaining_input_tokens=420,
        remaining_percent=46,
        display_remaining_tokens=520,
        display_remaining_percent=52,
        trigger_limit=810,
        target_limit=630,
        is_over_trigger=False,
    )
    current = ContextMetricsSnapshot(
        context_window=1000,
        reserved_output_tokens=100,
        available_input_tokens=900,
        used_input_tokens=490,
        remaining_input_tokens=410,
        remaining_percent=45,
        display_remaining_tokens=510,
        display_remaining_percent=51,
        trigger_limit=810,
        target_limit=630,
        is_over_trigger=False,
    )

    assert (
        should_emit_status_update(previous, current, phase=PHASE_AFTER_TOOL_END)
        is False
    )
    assert should_emit_status_update(previous, current, phase=PHASE_FINAL) is True


@pytest.mark.asyncio
async def test_tracker_capture_emits_at_boundaries():
    """Tracker is emit-only: capture(messages, phase) computes a snapshot and
    emits via the emitter (subject to throttling)."""
    emitter = AsyncMock()
    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        metrics_fn=_metrics_fn,
        emitter=emitter,
    )

    initial = await tracker.capture(
        [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Inspect the repository."},
        ],
        PHASE_BUILD_MESSAGES,
    )
    final_messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Inspect the repository."},
        {"role": "assistant", "content": "Done."},
    ]
    final = await tracker.capture(final_messages, PHASE_FINAL)

    emitted_phases = [
        call.kwargs["phase"] for call in emitter.status_updated.await_args_list
    ]
    assert emitted_phases == [PHASE_BUILD_MESSAGES, PHASE_FINAL]
    assert final.used_input_tokens >= initial.used_input_tokens
    assert tracker.latest_snapshot is final


@pytest.mark.asyncio
async def test_tracker_does_not_keep_internal_messages():
    """The new tracker holds no message duplicate — only the latest snapshot."""
    emitter = AsyncMock()
    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        metrics_fn=_metrics_fn,
        emitter=emitter,
    )

    assert not hasattr(tracker, "messages")
    assert not hasattr(tracker, "record_tool_start")
    assert not hasattr(tracker, "record_tool_end")
    assert not hasattr(tracker, "record_final_assistant_response")
    assert not hasattr(tracker, "initialize")


@pytest.mark.asyncio
async def test_tracker_uses_provided_metrics_fn():
    """Snapshot computation is delegated to the injected metrics_fn."""
    emitter = AsyncMock()
    captured_messages: list = []

    def fake_metrics_fn(messages):
        captured_messages.append(list(messages))
        return ContextMetricsSnapshot(
            context_window=1000,
            reserved_output_tokens=100,
            available_input_tokens=900,
            used_input_tokens=42,
            remaining_input_tokens=858,
            remaining_percent=95,
            display_remaining_tokens=958,
            display_remaining_percent=95,
            trigger_limit=810,
            target_limit=630,
            is_over_trigger=False,
        )

    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        metrics_fn=fake_metrics_fn,
        emitter=emitter,
    )

    msgs = [{"role": "user", "content": "hi"}]
    snapshot = await tracker.capture(msgs, PHASE_BUILD_MESSAGES)

    assert captured_messages == [msgs]
    assert snapshot.used_input_tokens == 42
