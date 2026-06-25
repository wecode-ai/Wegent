# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import chat_shell.guard.traces as traces
from chat_shell.guard.traces import record_protection_trace


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(
        traces, "add_span_event", lambda name, attrs: calls.append((name, attrs))
    )
    return calls


def test_event_name_and_status(monkeypatch):
    calls = _capture(monkeypatch)
    record_protection_trace("summary_compact", "completed", duration_ms=12.345)
    name, attrs = calls[0]
    assert name == "context_protection.summary_compact"
    assert attrs["operation"] == "summary_compact"
    assert attrs["status"] == "completed"
    assert attrs["duration_ms"] == 12.35  # rounded to 2dp


def test_tokens_saved_derived(monkeypatch):
    calls = _capture(monkeypatch)
    record_protection_trace(
        "attachment_preview", "applied", before_tokens=1000, after_tokens=300
    )
    _, attrs = calls[0]
    assert attrs["before_tokens"] == 1000
    assert attrs["after_tokens"] == 300
    assert attrs["tokens_saved"] == 700


def test_none_values_dropped(monkeypatch):
    calls = _capture(monkeypatch)
    record_protection_trace(
        "tool_output",
        "applied",
        duration_ms=None,
        before_tokens=None,
        after_tokens=None,
        failure_reason=None,
        messages_truncated=3,
    )
    _, attrs = calls[0]
    assert "duration_ms" not in attrs
    assert "before_tokens" not in attrs
    assert "tokens_saved" not in attrs
    assert "failure_reason" not in attrs
    assert attrs["messages_truncated"] == 3
