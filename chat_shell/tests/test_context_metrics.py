# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from chat_shell.agents.graph_builder import _extract_model_input_messages
from chat_shell.compression.config import get_model_context_config
from chat_shell.compression.context_metrics import (
    PHASE_AFTER_TOOL_END,
    PHASE_BUILD_MESSAGES,
    PHASE_FINAL,
    ContextMetricsSnapshot,
    ContextMetricsTracker,
    ProviderUsageBaseline,
    calculate_context_metrics,
    should_emit_status_update,
)
from chat_shell.compression.token_counter import TokenCounter


def _metrics_fn(messages, *, usage_baseline=None):
    return calculate_context_metrics(
        messages,
        model_id="gpt-4o",
        model_type="openai",
        model_config={
            "context_window": 800,
            "max_output_tokens": 100,
        },
        usage_baseline=usage_baseline,
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

    # reserved uses the flat buffer, capped by the explicitly configured model
    # output cap. clamp(32000 * 0.1, 16k, 48k) = 16000, then min(16000, 4000) = 4000.
    assert snapshot.context_window == 32000
    assert snapshot.reserved_output_tokens == 4000
    assert snapshot.available_input_tokens == 28000
    assert snapshot.used_input_tokens > 0
    assert snapshot.remaining_input_tokens < 28000
    assert snapshot.display_remaining_tokens < 32000


def test_calculate_context_metrics_prefers_provider_usage_baseline_plus_delta():
    messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Inspect the repository."},
        {"role": "assistant", "content": "Found the main modules."},
    ]
    counter = TokenCounter(model_name="gpt-4o", model_type="openai")
    baseline_messages = messages[:2]
    delta_tokens = counter.count_messages(messages[2:])
    snapshot = calculate_context_metrics(
        messages,
        model_id="gpt-4o",
        model_type="openai",
        model_config={
            "context_window": 32000,
            "max_output_tokens": 4000,
        },
        token_counter=counter,
        usage_baseline=ProviderUsageBaseline(
            input_tokens=1234,
            messages=baseline_messages,
        ),
    )

    assert snapshot.used_input_tokens == 1234 + delta_tokens


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

    def fake_metrics_fn(messages, *, usage_baseline=None):
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


@pytest.mark.asyncio
async def test_tracker_invalidates_provider_usage_baseline_on_prefix_mismatch():
    emitter = AsyncMock()
    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        metrics_fn=_metrics_fn,
        emitter=emitter,
    )
    baseline_messages = [{"role": "user", "content": "first"}]
    tracker.record_provider_usage(baseline_messages, input_tokens=500)

    mismatch_messages = [{"role": "user", "content": "different"}]
    snapshot = await tracker.capture(mismatch_messages, PHASE_BUILD_MESSAGES)

    assert tracker._usage_baseline is None
    assert snapshot.used_input_tokens != 500


@pytest.mark.asyncio
async def test_tracker_baseline_matches_even_when_live_view_has_extra_fields():
    emitter = AsyncMock()
    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        metrics_fn=_metrics_fn,
        emitter=emitter,
    )
    baseline_messages = [{"role": "user", "content": "same"}]
    tracker.record_provider_usage(baseline_messages, input_tokens=500)

    messages = [
        {
            "role": "user",
            "content": "same",
            "id": "h-1",
            "additional_kwargs": {"cache_control": {"type": "ephemeral"}},
        },
        {"role": "assistant", "content": "delta"},
    ]
    counter = TokenCounter(model_name="gpt-4o", model_type="openai")
    expected = 500 + counter.count_messages(messages[1:])

    snapshot = await tracker.capture(messages, PHASE_BUILD_MESSAGES)

    assert snapshot.used_input_tokens == expected


@pytest.mark.asyncio
async def test_tracker_baseline_matches_model_start_event_shape_against_guard_live_view():
    emitter = AsyncMock()
    tracker = ContextMetricsTracker(
        task_id=1,
        subtask_id=2,
        metrics_fn=_metrics_fn,
        emitter=emitter,
    )
    event = {
        "data": {
            "input": {
                "messages": [
                    HumanMessage(content="use tool"),
                    AIMessage(
                        content="",
                        tool_calls=[
                            {"id": "call_1", "name": "search", "args": {"q": "x"}}
                        ],
                    ),
                    ToolMessage(content="result", tool_call_id="call_1"),
                ]
            }
        }
    }
    baseline_messages = _extract_model_input_messages(event)
    assert baseline_messages is not None

    tracker.record_provider_usage(baseline_messages, input_tokens=700)

    live_view = [
        {
            "role": "user",
            "content": "use tool",
            "id": "u-1",
            "additional_kwargs": {"cache_control": {"type": "ephemeral"}},
        },
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_1", "name": "search", "args": {"q": "x"}}],
            "id": "a-1",
            "additional_kwargs": {},
        },
        {
            "role": "tool",
            "content": "result",
            "tool_call_id": "call_1",
            "id": "t-1",
            "additional_kwargs": {},
        },
        {"role": "assistant", "content": "delta"},
    ]
    counter = TokenCounter(model_name="gpt-4o", model_type="openai")
    expected = 700 + counter.count_messages(live_view[-1:])

    snapshot = await tracker.capture(live_view, PHASE_BUILD_MESSAGES)

    assert snapshot.used_input_tokens == expected


def test_auto_compact_token_limit_clamps_trigger_and_target(monkeypatch):
    from chat_shell.core.config import settings

    monkeypatch.setattr(settings, "AUTO_COMPACT_TOKEN_LIMIT", 3000)
    config = get_model_context_config(
        "gpt-4",
        model_config={"context_window": 10000, "max_output_tokens": 4000},
    )

    # reserved = min(clamp(1000, 16k, 48k), 4000) = 4000 -> available 6000
    assert config.available_tokens == 6000
    assert config.trigger_limit == 3000
    assert config.target_limit == 3000


def test_auto_compact_token_limit_never_exceeds_available_tokens(monkeypatch):
    from chat_shell.core.config import settings

    monkeypatch.setattr(settings, "AUTO_COMPACT_TOKEN_LIMIT", 9000)
    config = get_model_context_config(
        "gpt-4",
        model_config={"context_window": 10000, "max_output_tokens": 4000},
    )

    # reserved = min(clamp(1000, 16k, 48k), 4000) = 4000 -> available 6000;
    # override (9000) is clamped down to available, target follows.
    assert config.available_tokens == 6000
    assert config.trigger_limit == 6000
    assert config.target_limit == 4200
