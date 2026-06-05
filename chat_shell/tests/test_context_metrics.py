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
async def test_context_metrics_tracker_emits_initial_tool_and_final_snapshots():
    emitter = AsyncMock()
    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        model_id="gpt-4o",
        model_type="openai",
        model_config={
            "context_window": 800,
            "max_output_tokens": 100,
        },
        emitter=emitter,
    )

    await tracker.initialize(
        [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Inspect the repository."},
        ]
    )
    tracker.record_tool_start(
        tool_use_id="tool_1",
        tool_name="read_file",
        tool_input={"path": "graph_builder.py"},
    )
    await tracker.record_tool_end(
        tool_use_id="tool_1",
        tool_name="read_file",
        tool_output="A" * 1200,
    )
    final_snapshot = await tracker.record_final_assistant_response("Done.")

    emitted_phases = [
        call.kwargs["phase"] for call in emitter.status_updated.await_args_list
    ]
    assert emitted_phases[0] == PHASE_BUILD_MESSAGES
    assert PHASE_AFTER_TOOL_END in emitted_phases
    assert emitted_phases[-1] == PHASE_FINAL
    assert final_snapshot.used_input_tokens >= tracker.latest_snapshot.used_input_tokens
