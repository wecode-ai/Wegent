# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat_shell.guard.context_guard — UnifiedContextGuard (T3)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.guard.context_guard import UnifiedContextGuard
from chat_shell.guard.tool_output import COMPACTED_FLAG, ToolOutputGuardAdapter
from chat_shell.guard.types import TruncationPolicy

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def model_id():
    # gpt-4 has a tight context_window=8192 — easy to push over trigger.
    return "gpt-4"


@pytest.fixture
def tool_adapter():
    counter = TokenCounter(model_name="gpt-4")
    return ToolOutputGuardAdapter(
        token_counter=counter,
        default_policy=TruncationPolicy(kind="tokens", limit=50),
    )


@pytest.fixture
def guard(model_id, tool_adapter):
    return UnifiedContextGuard(
        model_id=model_id,
        sources=[tool_adapter],
        compression_enabled=True,
    )


@pytest.fixture
def guard_no_compression(model_id, tool_adapter):
    return UnifiedContextGuard(
        model_id=model_id,
        sources=[tool_adapter],
        compression_enabled=False,
    )


def _tool_msg(
    *, msg_id: str, content: str, tool_call_id: str = "t-1", name: str = "shell"
):
    return ToolMessage(
        content=content,
        tool_call_id=tool_call_id,
        name=name,
        id=msg_id,
    )


# ---------------------------------------------------------------------------
# __call__ entry
# ---------------------------------------------------------------------------


class TestEntryPoint:
    def test_empty_state_returns_empty_dict(self, guard):
        assert guard({}) == {}

    def test_no_messages_returns_empty_dict(self, guard):
        assert guard({"messages": []}) == {}

    def test_no_tool_messages_returns_empty_dict(self, guard):
        state = {
            "messages": [
                SystemMessage(content="sys", id="s-1"),
                HumanMessage(content="hello", id="h-1"),
                AIMessage(content="hi back", id="a-1"),
            ]
        }
        assert guard(state) == {}


# ---------------------------------------------------------------------------
# Stage 1: source pass
# ---------------------------------------------------------------------------


class TestSourcePass:
    def test_compacts_raw_tool_message(self, guard):
        big_body = "log line\n" * 500  # ~1000 tokens, well over 50-token policy
        state = {
            "messages": [
                HumanMessage(content="run it", id="h-1"),
                _tool_msg(msg_id="t-1", content=big_body),
            ]
        }

        result = guard(state)
        updates = result["messages"]

        # One upsert (replacement ToolMessage with same id), no compression yet.
        assert len(updates) == 1
        replacement = updates[0]
        assert isinstance(replacement, ToolMessage)
        assert replacement.id == "t-1"
        assert replacement.additional_kwargs.get(COMPACTED_FLAG) is True
        # Compact string carries the header.
        assert replacement.content.startswith("[tool_output ")
        assert "truncated=true" in replacement.content

    def test_skips_already_compacted(self, guard):
        already = _tool_msg(msg_id="t-1", content="[tool_output ...] body")
        already.additional_kwargs[COMPACTED_FLAG] = True

        state = {"messages": [HumanMessage(content="x", id="h-1"), already]}
        result = guard(state)

        # Source pass skipped; nothing else triggers; no updates.
        assert result == {}

    def test_processes_only_unflagged_when_mixed(self, guard):
        compacted = _tool_msg(msg_id="t-1", content="[tool_output already compact]")
        compacted.additional_kwargs[COMPACTED_FLAG] = True
        big = "x " * 800  # large, will be truncated
        raw = _tool_msg(msg_id="t-2", content=big)

        state = {"messages": [HumanMessage(content="x", id="h-1"), compacted, raw]}
        updates = guard(state)["messages"]

        assert len(updates) == 1
        assert updates[0].id == "t-2"

    def test_message_without_id_is_skipped(self, guard, caplog):
        # Tool message with explicit empty id — guard must skip safely.
        msg = ToolMessage(content="x" * 5000, tool_call_id="t-1", name="shell")
        # ToolMessage assigns its own id by default; force it empty.
        msg.id = ""

        state = {"messages": [HumanMessage(content="x", id="h-1"), msg]}
        with caplog.at_level("WARNING"):
            result = guard(state)

        assert result == {}
        assert any("without id" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# Stage 2: compression pass
# ---------------------------------------------------------------------------


class TestCompressionPass:
    def test_no_compression_when_under_trigger(self, guard):
        state = {
            "messages": [
                HumanMessage(content="hi", id="h-1"),
                AIMessage(content="hello", id="a-1"),
            ]
        }
        assert guard(state) == {}

    def test_no_compression_when_disabled(self, guard_no_compression, monkeypatch):
        # Even if over trigger, no compression runs.
        guard_no_compression._compressor = None
        big = HumanMessage(content="x " * 50_000, id="h-big")
        result = guard_no_compression({"messages": [big]})
        # No source applies; no compression; should be {}.
        assert result == {}

    def test_compression_emits_remove_and_synthesized(self, guard, monkeypatch):
        """When compressor drops messages and synthesizes a summary, the guard
        must emit RemoveMessage for each dropped id and a fresh BaseMessage
        upsert (without an existing id) for each synthesized message."""
        # Compose state so that source-stage produces no updates and we can
        # observe stage 2 in isolation.
        state = {
            "messages": [
                HumanMessage(content="hi", id="h-1"),
                AIMessage(content="ok", id="a-1"),
                HumanMessage(content="more", id="h-2"),
                AIMessage(content="reply", id="a-2"),
            ]
        }

        # Force is_over_trigger True for one call by stubbing the counter.
        original_count = guard._counter.count_messages
        calls = {"n": 0}

        def fake_count(messages):
            calls["n"] += 1
            return guard.trigger_limit + 1 if calls["n"] == 1 else 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)

        # Stub compressor: drop h-1 and a-1, synthesize a summary message.
        fake_result = MagicMock()
        fake_result.was_compressed = True
        fake_result.original_tokens = guard.trigger_limit + 1
        fake_result.compressed_tokens = guard.trigger_limit - 100
        fake_result.strategies_applied = ["history"]
        fake_result.messages = [
            {"role": "user", "content": "[summary]", "additional_kwargs": {}},
            {"role": "user", "content": "more", "id": "h-2", "additional_kwargs": {}},
            {
                "role": "assistant",
                "content": "reply",
                "id": "a-2",
                "additional_kwargs": {},
            },
        ]

        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        updates = guard(state)["messages"]

        # h-1, a-1 removed. Summary added (no pre-existing id).
        remove_ids = {u.id for u in updates if isinstance(u, RemoveMessage)}
        assert remove_ids == {"h-1", "a-1"}
        synthesized = [u for u in updates if not isinstance(u, RemoveMessage)]
        assert len(synthesized) == 1
        assert synthesized[0].content == "[summary]"
        assert synthesized[0].additional_kwargs.get(COMPACTED_FLAG) is True


# ---------------------------------------------------------------------------
# Stage 3 stub
# ---------------------------------------------------------------------------


class TestEmergencyStub:
    def test_warns_when_still_over_after_compression(self, guard, monkeypatch, caplog):
        """T7 will implement this. T3 logs a warning so the gap is visible."""
        # Force is_over_trigger to remain True throughout the pipeline.
        monkeypatch.setattr(
            guard._counter, "count_messages", lambda msgs: guard.trigger_limit + 1
        )
        # Stub compressor to claim compression but not actually shrink.
        fake_result = MagicMock()
        fake_result.was_compressed = False  # → stage 2 returns no updates
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {"messages": [HumanMessage(content="hi", id="h-1")]}
        with caplog.at_level("WARNING"):
            guard(state)

        assert any(
            "Emergency pass not implemented" in r.getMessage() for r in caplog.records
        )


# ---------------------------------------------------------------------------
# metrics() and trigger_limit
# ---------------------------------------------------------------------------


class TestMetrics:
    def test_metrics_matches_calculate_helper(self, guard, model_id):
        from chat_shell.compression.context_metrics import calculate_context_metrics

        messages = [{"role": "user", "content": "hello world"}]
        snapshot = guard.metrics(messages)
        expected = calculate_context_metrics(messages, model_id=model_id)

        assert snapshot.context_window == expected.context_window
        assert snapshot.used_input_tokens == expected.used_input_tokens
        assert snapshot.is_over_trigger == expected.is_over_trigger

    def test_trigger_limit_property(self, guard):
        assert guard.trigger_limit > 0


# ---------------------------------------------------------------------------
# Source policy lookup
# ---------------------------------------------------------------------------


class TestSourcePolicyLookup:
    def test_raises_when_source_lacks_default_policy(self, model_id):
        class BadSource:
            name = "bad"

            def applies_to(self, message):
                return message.get("type") == "tool" or message.get("role") == "tool"

            def is_already_compact(self, message):
                return False

            def extract_raw(self, message):
                return {"text": message.get("content", "")}

            def to_model_visible(self, raw, policy):
                return str(raw)

            def emergency_policy(self, normal):
                return normal

        guard = UnifiedContextGuard(
            model_id=model_id,
            sources=[BadSource()],
        )

        state = {"messages": [_tool_msg(msg_id="t-1", content="x" * 200)]}
        with pytest.raises(ValueError, match="default_policy"):
            guard(state)
