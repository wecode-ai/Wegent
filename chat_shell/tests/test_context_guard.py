# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat_shell.guard.context_guard — UnifiedContextGuard (T3)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)

from chat_shell.compression.context_metrics import ProviderUsageBaseline
from chat_shell.compression.summary_compactor import (
    SummaryCompactNotApplicable,
    SummaryCompactResult,
)
from chat_shell.compression.token_counter import TokenCounter
from chat_shell.guard.context_guard import (
    ContextGuardFailFastError,
    UnifiedContextGuard,
)
from chat_shell.guard.tool_output import COMPACTED_FLAG, ToolOutputGuardAdapter
from chat_shell.guard.types import TruncationPolicy


class _FakeSummaryCompactor:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls = []

    async def compact(self, messages, *, preserve_initial_context):
        self.calls.append(
            {
                "messages": messages,
                "preserve_initial_context": preserve_initial_context,
            }
        )
        if self.error is not None:
            raise self.error
        return self.result


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
    async def test_empty_state_returns_empty_dict(self, guard):
        assert await guard({}) == {}

    async def test_no_messages_returns_empty_dict(self, guard):
        assert await guard({"messages": []}) == {}

    async def test_no_tool_messages_returns_empty_dict(self, guard):
        state = {
            "messages": [
                SystemMessage(content="sys", id="s-1"),
                HumanMessage(content="hello", id="h-1"),
                AIMessage(content="hi back", id="a-1"),
            ]
        }
        assert await guard(state) == {}


# ---------------------------------------------------------------------------
# Stage 1: source pass
# ---------------------------------------------------------------------------


class TestSourcePass:
    async def test_compacts_raw_tool_message(self, guard):
        big_body = "log line\n" * 500  # ~1000 tokens, well over 50-token policy
        state = {
            "messages": [
                HumanMessage(content="run it", id="h-1"),
                _tool_msg(msg_id="t-1", content=big_body),
            ]
        }

        result = await guard(state)
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

    async def test_skips_already_compacted(self, guard):
        already = _tool_msg(msg_id="t-1", content="[tool_output ...] body")
        already.additional_kwargs[COMPACTED_FLAG] = True

        state = {"messages": [HumanMessage(content="x", id="h-1"), already]}
        result = await guard(state)

        # Source pass skipped; nothing else triggers; no updates.
        assert result == {}

    async def test_processes_only_unflagged_when_mixed(self, guard):
        compacted = _tool_msg(msg_id="t-1", content="[tool_output already compact]")
        compacted.additional_kwargs[COMPACTED_FLAG] = True
        big = "x " * 800  # large, will be truncated
        raw = _tool_msg(msg_id="t-2", content=big)

        state = {"messages": [HumanMessage(content="x", id="h-1"), compacted, raw]}
        updates = (await guard(state))["messages"]

        assert len(updates) == 1
        assert updates[0].id == "t-2"

    async def test_message_without_id_is_skipped(self, guard, caplog):
        # Tool message with explicit empty id — guard must skip safely.
        msg = ToolMessage(content="x" * 5000, tool_call_id="t-1", name="shell")
        # ToolMessage assigns its own id by default; force it empty.
        msg.id = ""

        state = {"messages": [HumanMessage(content="x", id="h-1"), msg]}
        with caplog.at_level("WARNING"):
            result = await guard(state)

        assert result == {}
        assert any("without id" in r.getMessage() for r in caplog.records)

    async def test_preserves_cache_control_in_additional_kwargs(self, guard):
        """Anthropic prompt-cache breakpoints live in
        ``additional_kwargs["cache_control"]`` and are added by
        :func:`MessageConverter.apply_cache_breakpoints` before the guard runs.
        Stage 1 compaction must merge — not overwrite — ``additional_kwargs``
        so the cache marker survives onto the replacement message and the
        ``compacted`` flag is added alongside it."""
        big_body = "log line\n" * 500  # forces truncation under the 50-token policy
        cache_marker = {"type": "ephemeral"}
        msg = _tool_msg(msg_id="t-1", content=big_body)
        msg.additional_kwargs["cache_control"] = cache_marker

        state = {
            "messages": [
                HumanMessage(content="run it", id="h-1"),
                msg,
            ]
        }

        result = await guard(state)
        updates = result["messages"]

        assert len(updates) == 1
        replacement = updates[0]
        assert isinstance(replacement, ToolMessage)
        assert replacement.id == "t-1"
        # Both flags coexist on the replacement: cache marker preserved,
        # compacted flag added.
        assert replacement.additional_kwargs.get("cache_control") == cache_marker
        assert replacement.additional_kwargs.get(COMPACTED_FLAG) is True

    async def test_uses_tool_specific_policy_override(self, model_id):
        """Source-level pass should pick the policy based on message.name."""
        counter = TokenCounter(model_name=model_id)
        adapter = ToolOutputGuardAdapter(
            token_counter=counter,
            default_policy=TruncationPolicy(kind="tokens", limit=50),
            tool_policy_overrides={
                "knowledge_base_search": TruncationPolicy(kind="tokens", limit=120)
            },
        )
        guard = UnifiedContextGuard(
            model_id=model_id,
            sources=[adapter],
            compression_enabled=False,
        )

        body = "knowledge line\n" * 200
        state = {
            "messages": [
                HumanMessage(content="search", id="h-1"),
                ToolMessage(
                    content=body,
                    tool_call_id="t-1",
                    name="knowledge_base_search",
                    id="tool-1",
                ),
            ]
        }

        updates = (await guard(state))["messages"]
        assert len(updates) == 1
        replacement = updates[0]
        assert isinstance(replacement, ToolMessage)
        assert "truncated=true" in replacement.content
        header = replacement.content.split("\n", 1)[0]
        assert "name=knowledge_base_search" in header
        # Sanity check that the larger override was used: the rendered output
        # should be materially larger than a 50-token cap would allow.
        assert len(replacement.content) > 300

    async def test_skips_direct_injection_source_compaction(self, guard):
        """Knowledge direct-injection payloads bypass source-level truncation."""
        direct_injection_payload = json.dumps(
            {
                "mode": "direct_injection",
                "injected_content": "knowledge line\n" * 80,
                "count": 8,
            }
        )
        state = {
            "messages": [
                HumanMessage(content="search", id="h-1"),
                ToolMessage(
                    content=direct_injection_payload,
                    tool_call_id="t-1",
                    name="knowledge_base_search",
                    id="tool-1",
                ),
            ]
        }

        result = await guard(state)

        # Source pass skips this message entirely; no replacement upsert.
        assert result == {}


# ---------------------------------------------------------------------------
# Stage 2: compression pass
# ---------------------------------------------------------------------------


class TestCompressionPass:
    async def test_no_compression_when_under_trigger(self, guard):
        state = {
            "messages": [
                HumanMessage(content="hi", id="h-1"),
                AIMessage(content="hello", id="a-1"),
            ]
        }
        assert await guard(state) == {}

    async def test_no_compression_when_disabled(
        self, guard_no_compression, monkeypatch
    ):
        # Even if over trigger, no compression runs.
        guard_no_compression._compressor = None
        big = HumanMessage(content="x " * 50_000, id="h-big")
        result = await guard_no_compression({"messages": [big]})
        # No source applies; no compression; should be {}.
        assert result == {}

    async def test_summary_compact_rewrites_history_before_legacy_fallback(
        self, guard, monkeypatch
    ):
        state = {
            "messages": [
                SystemMessage(content="system", id="s-1"),
                HumanMessage(content="older user", id="h-1"),
                AIMessage(content="assistant", id="a-1"),
                HumanMessage(content="latest user", id="h-2"),
            ]
        }

        fake_result = SummaryCompactResult(
            summary_text="Current objective:\ncontinue",
            replacement_history=[
                SystemMessage(content="system"),
                HumanMessage(content="latest user"),
                HumanMessage(
                    content="[COMPACT SUMMARY]\n\nCurrent objective:\ncontinue",
                    additional_kwargs={
                        "compacted": True,
                        "summary_compacted": True,
                    },
                ),
            ],
            removed_history_items=2,
        )
        fake_compactor = _FakeSummaryCompactor(result=fake_result)
        guard._summary_compactor = fake_compactor

        calls = {"n": 0}

        def fake_count(messages):
            calls["n"] += 1
            if calls["n"] == 1:
                return guard.trigger_limit + 100
            return 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)
        compressor_calls = []
        monkeypatch.setattr(
            guard._compressor,
            "compress_if_needed",
            lambda msgs: compressor_calls.append(msgs),
        )

        updates = (await guard(state))["messages"]

        assert fake_compactor.calls
        assert fake_compactor.calls[0]["preserve_initial_context"] is True
        assert compressor_calls == []
        remove_ids = {u.id for u in updates if isinstance(u, RemoveMessage)}
        assert remove_ids == {"s-1", "h-1", "a-1", "h-2"}
        non_remove = [u for u in updates if not isinstance(u, RemoveMessage)]
        assert len(non_remove) == 3
        assert non_remove[-1].additional_kwargs["summary_compacted"] is True
        assert guard.context_compactions[0]["strategy"] == "summary_compact"

    async def test_summary_compact_failure_falls_back_to_legacy_compressor(
        self, guard, monkeypatch
    ):
        guard._summary_compactor = _FakeSummaryCompactor(
            error=RuntimeError("context length exceeded")
        )
        state = {
            "messages": [
                HumanMessage(content="hi", id="h-1"),
                AIMessage(content="ok", id="a-1"),
            ]
        }

        calls = {"n": 0}

        def fake_count(messages):
            calls["n"] += 1
            return guard.trigger_limit + 100 if calls["n"] == 1 else 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)

        fake_result = MagicMock()
        fake_result.was_compressed = True
        fake_result.original_tokens = guard.trigger_limit + 100
        fake_result.compressed_tokens = guard.trigger_limit - 1
        fake_result.strategies_applied = ["history"]
        fake_result.messages = [
            {"role": "user", "content": "[legacy summary]", "additional_kwargs": {}}
        ]
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        updates = (await guard(state))["messages"]

        assert len(updates) == 3
        assert {u.id for u in updates if isinstance(u, RemoveMessage)} == {
            "h-1",
            "a-1",
        }
        synthesized = [u for u in updates if not isinstance(u, RemoveMessage)]
        assert synthesized[0].content == "[legacy summary]"

    async def test_summary_compact_failure_without_legacy_compressor_keeps_flag_false(
        self, guard_no_compression, monkeypatch
    ):
        guard_no_compression._summary_compactor = _FakeSummaryCompactor(
            error=RuntimeError("context length exceeded")
        )
        state = {
            "messages": [
                HumanMessage(content="x " * 50_000, id="h-1"),
            ]
        }
        monkeypatch.setattr(
            guard_no_compression._counter,
            "count_messages",
            lambda messages: guard_no_compression.trigger_limit + 100,
        )

        result = await guard_no_compression(state)

        assert result == {}
        assert guard_no_compression.context_compactions[0]["status"] == "fallback"
        assert (
            guard_no_compression.context_compactions[0]["used_legacy_fallback"] is False
        )

    async def test_summary_compact_not_applicable_sets_specific_failure_reason(
        self, guard_no_compression, monkeypatch
    ):
        guard_no_compression._summary_compactor = _FakeSummaryCompactor(
            error=SummaryCompactNotApplicable("floor too large")
        )
        state = {
            "messages": [
                HumanMessage(content="x " * 50_000, id="h-1"),
            ]
        }
        monkeypatch.setattr(
            guard_no_compression._counter,
            "count_messages",
            lambda messages: guard_no_compression.trigger_limit + 100,
        )

        await guard_no_compression(state)

        assert (
            guard_no_compression.context_compactions[0]["failure_reason"]
            == "summary_compact_not_applicable"
        )

    async def test_over_trigger_uses_provider_usage_baseline(self, guard):
        state = {
            "messages": [
                HumanMessage(content="x " * 10_000, id="h-1"),
            ]
        }
        guard._summary_compactor = _FakeSummaryCompactor(
            result=SummaryCompactResult(
                summary_text="Current objective:\ncontinue",
                replacement_history=[HumanMessage(content="[COMPACT SUMMARY]")],
                removed_history_items=1,
            )
        )
        tracker = MagicMock()
        tracker.usage_baseline = ProviderUsageBaseline(
            input_tokens=100,
            messages=[{"role": "user", "content": "x " * 10_000}],
        )
        guard.set_tracker(tracker)

        result = await guard(state)

        assert result == {}
        assert guard._summary_compactor.calls == []

    async def test_compression_emits_remove_and_synthesized(self, guard, monkeypatch):
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

        updates = (await guard(state))["messages"]

        # h-1, a-1 removed. Summary added (no pre-existing id).
        remove_ids = {u.id for u in updates if isinstance(u, RemoveMessage)}
        assert remove_ids == {"h-1", "a-1"}
        synthesized = [u for u in updates if not isinstance(u, RemoveMessage)]
        assert len(synthesized) == 1
        assert synthesized[0].content == "[summary]"
        assert synthesized[0].additional_kwargs.get(COMPACTED_FLAG) is True

    async def test_synthesized_message_preserves_compressor_id(
        self, guard, monkeypatch
    ):
        """When the compressor synthesizes a message with a stable ``id``, the
        constructed BaseMessage must carry that id forward — otherwise
        LangChain would mint a fresh one and downstream upserts via
        ``add_messages`` would no longer match the compressor's view."""
        state = {
            "messages": [
                HumanMessage(content="hi", id="h-1"),
                AIMessage(content="ok", id="a-1"),
            ]
        }

        calls = {"n": 0}

        def fake_count(messages):
            calls["n"] += 1
            return guard.trigger_limit + 1 if calls["n"] == 1 else 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)

        # Synthesized message carries an explicit id — must survive the
        # dict -> BaseMessage round-trip.
        synthesized_id = "summary-stable-id"
        fake_result = MagicMock()
        fake_result.was_compressed = True
        fake_result.original_tokens = guard.trigger_limit + 1
        fake_result.compressed_tokens = guard.trigger_limit - 100
        fake_result.strategies_applied = ["history"]
        fake_result.messages = [
            {
                "role": "user",
                "content": "[summary]",
                "id": synthesized_id,
                "additional_kwargs": {},
            },
        ]

        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        updates = (await guard(state))["messages"]

        synthesized = [u for u in updates if not isinstance(u, RemoveMessage)]
        assert len(synthesized) == 1
        assert synthesized[0].id == synthesized_id

    async def test_retained_message_with_same_id_but_new_content_is_upserted(
        self, guard, monkeypatch
    ):
        """Compression may mutate a kept message in place (same id, new content).

        The guard must emit an upsert for that retained message rather than
        treating every surviving id as an unchanged passthrough.
        """
        state = {
            "messages": [
                HumanMessage(content="older", id="h-1"),
                AIMessage(content="reply", id="a-1"),
            ]
        }

        calls = {"n": 0}

        def fake_count(messages):
            calls["n"] += 1
            return guard.trigger_limit + 1 if calls["n"] == 1 else 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)

        fake_result = MagicMock()
        fake_result.was_compressed = True
        fake_result.original_tokens = guard.trigger_limit + 1
        fake_result.compressed_tokens = guard.trigger_limit - 100
        fake_result.strategies_applied = ["history"]
        fake_result.messages = [
            {
                "role": "assistant",
                "content": "[truncated history]\n\nreply",
                "id": "a-1",
                "additional_kwargs": {},
            }
        ]

        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        updates = (await guard(state))["messages"]

        remove_ids = {u.id for u in updates if isinstance(u, RemoveMessage)}
        assert remove_ids == {"h-1"}
        replacements = [u for u in updates if not isinstance(u, RemoveMessage)]
        assert len(replacements) == 1
        assert replacements[0].id == "a-1"
        assert replacements[0].content == "[truncated history]\n\nreply"
        assert replacements[0].additional_kwargs.get(COMPACTED_FLAG) is True

    async def test_fail_fast_when_bypass_protected_payload_still_over_trigger(
        self, guard, monkeypatch
    ):
        """Protected direct-injection payloads must not be mutilated by
        request-level/emergency passes; if the request still cannot fit, the
        guard should fail fast instead of silently truncating the payload."""
        direct_injection_payload = json.dumps(
            {
                "mode": "direct_injection",
                "injected_content": "knowledge line\n" * 4000,
                "count": 8,
            }
        )
        state = {
            "messages": [
                HumanMessage(content="search", id="h-1"),
                ToolMessage(
                    content=direct_injection_payload,
                    tool_call_id="t-1",
                    name="knowledge_base_search",
                    id="tool-1",
                ),
            ]
        }

        monkeypatch.setattr(
            guard._counter,
            "count_messages",
            lambda msgs: guard.trigger_limit + 1,
        )

        with pytest.raises(ContextGuardFailFastError):
            await guard(state)


# ---------------------------------------------------------------------------
# Stage 3: emergency re-truncation (T7)
# ---------------------------------------------------------------------------


class TestEmergencyPass:
    """T7: emergency re-truncation kicks in when stage 1 + stage 2 weren't enough."""

    def _make_compacted_tool(self, *, msg_id: str, content: str) -> ToolMessage:
        """Build a tool message already flagged compacted so stage 1 skips it."""
        msg = _tool_msg(msg_id=msg_id, content=content)
        msg.additional_kwargs[COMPACTED_FLAG] = True
        return msg

    def _make_real_compacted_tool(
        self, *, msg_id: str, raw_text: str, tool_adapter
    ) -> ToolMessage:
        """Build a tool message whose content is a real compact string the
        adapter would have produced in stage 1. Used to exercise stage 3
        re-rendering without the synthetic '[just opaque text + flag]' shortcut.
        """
        compact = tool_adapter.to_model_visible(
            {"text": raw_text, "tool_name": "shell"}, tool_adapter.default_policy
        )
        msg = ToolMessage(
            content=compact,
            tool_call_id="t-1",
            name="shell",
            id=msg_id,
        )
        msg.additional_kwargs[COMPACTED_FLAG] = True
        return msg

    async def test_re_truncates_compacted_message_under_emergency_policy(
        self, guard, monkeypatch
    ):
        """When stage 1 already compacted a message and stage 2 didn't help,
        stage 3 must re-render it under the source's emergency policy."""
        big = "x " * 4000
        already = self._make_compacted_tool(msg_id="t-1", content=big)

        # Force perpetual over-trigger so stage 3 actually runs.
        monkeypatch.setattr(
            guard._counter,
            "count_messages",
            lambda msgs: guard.trigger_limit + 1,
        )
        # Compressor declines (no synthesized messages to confuse the test).
        fake_result = MagicMock()
        fake_result.was_compressed = False
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {"messages": [HumanMessage(content="run", id="h-1"), already]}
        updates = (await guard(state))["messages"]

        assert len(updates) == 1
        replacement = updates[0]
        assert isinstance(replacement, ToolMessage)
        assert replacement.id == "t-1"
        assert replacement.additional_kwargs.get(COMPACTED_FLAG) is True
        # Emergency body is materially smaller than the original.
        assert len(replacement.content) < len(big)
        assert replacement.content.startswith("[tool_output ")
        assert "truncated=true" in replacement.content

    async def test_re_truncating_real_compact_string_does_not_nest_headers(
        self, guard, tool_adapter, monkeypatch
    ):
        """Realistic stage-1 → stage-3 flow: the message already holds a real
        compact string from stage 1. Stage 3 must NOT wrap it again — exactly
        one header and one footer in the output."""
        raw_text = "log line\n" * 500
        already = self._make_real_compacted_tool(
            msg_id="t-1", raw_text=raw_text, tool_adapter=tool_adapter
        )

        monkeypatch.setattr(
            guard._counter,
            "count_messages",
            lambda msgs: guard.trigger_limit + 1,
        )
        fake_result = MagicMock()
        fake_result.was_compressed = False
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {"messages": [HumanMessage(content="run", id="h-1"), already]}
        updates = (await guard(state))["messages"]

        assert len(updates) == 1
        replacement = updates[0]
        # Exactly one header and zero footers (the original raw text had no
        # exit_code/wall_time, so neither stage-1 nor stage-3 emits one).
        assert replacement.content.count("[tool_output ") == 1
        # Header total_tokens is the count of the body the adapter sees at
        # stage 3 — i.e., the stage-1 body, NOT the compact wrapper.
        assert "[tool_output " in replacement.content
        # The emergency-rendered string must shrink relative to the stage-1
        # compact form on the message.
        assert len(replacement.content) < len(already.content)

    async def test_attacks_biggest_first_and_stops_under_trigger(
        self, guard, monkeypatch
    ):
        """Largest message is rewritten first; pass stops as soon as live state
        drops back under trigger so smaller messages are left alone."""
        big = self._make_compacted_tool(msg_id="t-big", content="X" * 8000)
        small = self._make_compacted_tool(msg_id="t-small", content="Y" * 1000)

        # Counter: first call (stage-2 trigger check) over, then under after
        # the first stage-3 rewrite — exactly mimics the early-stop condition.
        call_state = {"n": 0}

        def fake_count(msgs):
            call_state["n"] += 1
            return guard.trigger_limit + 1 if call_state["n"] <= 2 else 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)
        fake_result = MagicMock()
        fake_result.was_compressed = False
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {
            "messages": [
                HumanMessage(content="run", id="h-1"),
                small,
                big,
            ]
        }
        updates = (await guard(state))["messages"]

        # Only the larger message is rewritten — early stop kicks in.
        assert len(updates) == 1
        assert updates[0].id == "t-big"

    async def test_warns_when_emergency_pass_cannot_recover(
        self, guard, monkeypatch, caplog
    ):
        """If even after rewriting under emergency policy the state is still
        over trigger, log a warning so operators see the gap."""
        already = self._make_compacted_tool(msg_id="t-1", content="x" * 4000)

        # Always over trigger.
        monkeypatch.setattr(
            guard._counter,
            "count_messages",
            lambda msgs: guard.trigger_limit + 1,
        )
        fake_result = MagicMock()
        fake_result.was_compressed = False
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {"messages": [HumanMessage(content="run", id="h-1"), already]}
        with caplog.at_level("WARNING"):
            await guard(state)

        assert any(
            "still over trigger after emergency pass" in r.getMessage()
            for r in caplog.records
        )

    async def test_no_warning_when_emergency_pass_recovers(
        self, guard, monkeypatch, caplog
    ):
        """If emergency pass brings state back under trigger, no warning fires."""
        already = self._make_compacted_tool(msg_id="t-1", content="x" * 4000)

        call_state = {"n": 0}

        def fake_count(msgs):
            call_state["n"] += 1
            # Over trigger up through the post-stage-2 check, under after the
            # first emergency rewrite.
            return guard.trigger_limit + 1 if call_state["n"] <= 2 else 0

        monkeypatch.setattr(guard._counter, "count_messages", fake_count)
        fake_result = MagicMock()
        fake_result.was_compressed = False
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {"messages": [HumanMessage(content="run", id="h-1"), already]}
        with caplog.at_level("WARNING"):
            await guard(state)

        assert not any(
            "still over trigger after emergency pass" in r.getMessage()
            for r in caplog.records
        )

    async def test_skips_synthesized_messages_without_original(
        self, guard, monkeypatch
    ):
        """Synthesized messages from stage 2 don't have a matching BaseMessage
        in the input list — they must be excluded from emergency candidates so
        the upsert-by-id contract holds."""
        already = self._make_compacted_tool(msg_id="t-1", content="x" * 4000)

        monkeypatch.setattr(
            guard._counter,
            "count_messages",
            lambda msgs: guard.trigger_limit + 1,
        )

        # Stage 2 drops the original tool message and synthesizes a summary.
        fake_result = MagicMock()
        fake_result.was_compressed = True
        fake_result.original_tokens = guard.trigger_limit + 1
        fake_result.compressed_tokens = guard.trigger_limit + 1
        fake_result.strategies_applied = ["history"]
        fake_result.messages = [
            {
                "role": "user",
                "content": "[summary]",
                "id": "synthesized-1",
                "additional_kwargs": {COMPACTED_FLAG: True},
            },
        ]
        monkeypatch.setattr(
            guard._compressor, "compress_if_needed", lambda msgs: fake_result
        )

        state = {"messages": [HumanMessage(content="run", id="h-1"), already]}
        updates = (await guard(state))["messages"]

        # Only stage 2's RemoveMessage(s) plus the synthesized summary appear.
        # Stage 3 finds no eligible candidates because the synthesized message
        # has no matching original BaseMessage.
        non_remove = [u for u in updates if not isinstance(u, RemoveMessage)]
        # Synthesized message kept but no emergency rewrite added.
        assert all(
            not (isinstance(u, ToolMessage) and u.id == "t-1") for u in non_remove
        )


# ---------------------------------------------------------------------------
# Tracker integration (review issue #2 — mid-turn metric updates)
# ---------------------------------------------------------------------------


class TestTrackerEmits:
    """The guard emits a metrics snapshot via the tracker on every invocation
    so the frontend toolbar reflects mid-turn state changes (growth from new
    tool results, shrinkage from compaction)."""

    async def test_emits_after_compaction_phase_when_compaction_happened(self, guard):
        from unittest.mock import AsyncMock

        from chat_shell.compression.context_metrics import (
            PHASE_AFTER_COMPACTION,
            ContextMetricsSnapshot,
            ContextMetricsTracker,
        )

        # Stub a tracker that records every capture call.
        emitter = AsyncMock()
        tracker = ContextMetricsTracker(
            task_id=1,
            subtask_id=2,
            metrics_fn=guard.metrics,
            emitter=emitter,
        )
        guard.set_tracker(tracker)

        # Force compaction by giving the source a real raw tool message.
        big_body = "log line\n" * 500
        state = {
            "messages": [
                HumanMessage(content="run", id="h-1"),
                _tool_msg(msg_id="t-1", content=big_body),
            ]
        }

        await guard(state)

        # Compaction happened (stage 1 produced an update) → AFTER_COMPACTION.
        emitted_phases = [
            call.kwargs["phase"] for call in emitter.status_updated.await_args_list
        ]
        assert emitted_phases == [PHASE_AFTER_COMPACTION]

    async def test_emits_after_tool_end_phase_when_no_compaction(self, guard):
        from unittest.mock import AsyncMock

        from chat_shell.compression.context_metrics import (
            PHASE_AFTER_TOOL_END,
            ContextMetricsTracker,
        )

        emitter = AsyncMock()
        tracker = ContextMetricsTracker(
            task_id=1,
            subtask_id=2,
            metrics_fn=guard.metrics,
            emitter=emitter,
        )
        guard.set_tracker(tracker)

        # Small state with no tool messages → no compaction, but still emits.
        state = {
            "messages": [
                HumanMessage(content="hi", id="h-1"),
                AIMessage(content="hello", id="a-1"),
            ]
        }
        await guard(state)

        emitted_phases = [
            call.kwargs["phase"] for call in emitter.status_updated.await_args_list
        ]
        # AFTER_TOOL_END goes through bucket-throttling. With no prior emit
        # (last_emitted_snapshot is None), the throttle returns True so the
        # first such call IS emitted.
        assert emitted_phases == [PHASE_AFTER_TOOL_END]

    async def test_summary_compaction_emits_started_and_completed_runtime_events(
        self, guard
    ):
        from unittest.mock import AsyncMock

        from chat_shell.compression.context_metrics import ContextMetricsTracker

        emitter = AsyncMock()
        tracker = ContextMetricsTracker(
            task_id=1,
            subtask_id=2,
            metrics_fn=guard.metrics,
            emitter=emitter,
        )
        guard.set_tracker(tracker)
        guard._summary_compactor = _FakeSummaryCompactor(
            result=SummaryCompactResult(
                summary_text="Current objective:\ncontinue",
                replacement_history=[
                    HumanMessage(
                        content="[COMPACT SUMMARY]\n\nCurrent objective:\ncontinue"
                    )
                ],
                removed_history_items=1,
            )
        )

        state = {
            "messages": [
                HumanMessage(content="x" * 40000, id="h-1"),
                AIMessage(content="y" * 40000, id="a-1"),
            ]
        }

        await guard(state)

        compaction_statuses = [
            call.kwargs["context_compaction"]["status"]
            for call in emitter.status_updated.await_args_list
            if call.kwargs.get("context_compaction") is not None
        ]
        assert compaction_statuses == ["started", "completed"]

    async def test_summary_compaction_failure_emits_fallback_runtime_event(self, guard):
        from unittest.mock import AsyncMock

        from chat_shell.compression.context_metrics import ContextMetricsTracker

        emitter = AsyncMock()
        tracker = ContextMetricsTracker(
            task_id=1,
            subtask_id=2,
            metrics_fn=guard.metrics,
            emitter=emitter,
        )
        guard.set_tracker(tracker)
        guard._summary_compactor = _FakeSummaryCompactor(
            error=RuntimeError("context length exceeded")
        )

        state = {
            "messages": [
                HumanMessage(content="x" * 40000, id="h-1"),
                AIMessage(content="y" * 40000, id="a-1"),
            ]
        }

        await guard(state)

        compaction_statuses = [
            call.kwargs["context_compaction"]["status"]
            for call in emitter.status_updated.await_args_list
            if call.kwargs.get("context_compaction") is not None
        ]
        assert compaction_statuses == ["started", "fallback"]

    async def test_no_tracker_no_emit(self, guard):
        """When no tracker is wired, the guard simply skips emitting — no
        crashes, no warnings."""
        # guard fixture has no tracker by default.
        big_body = "log line\n" * 500
        state = {
            "messages": [
                HumanMessage(content="run", id="h-1"),
                _tool_msg(msg_id="t-1", content=big_body),
            ]
        }
        result = await guard(state)
        # Compaction still happens; just no emit.
        assert "messages" in result

    async def test_tracker_failure_does_not_break_guard(self, guard, caplog):
        """Telemetry must never crash the model loop. If tracker.capture
        raises, the guard logs and continues to return the budget updates."""
        from unittest.mock import AsyncMock, MagicMock

        from chat_shell.compression.context_metrics import ContextMetricsTracker

        tracker = MagicMock(spec=ContextMetricsTracker)
        tracker.capture = AsyncMock(side_effect=RuntimeError("emit broke"))
        guard.set_tracker(tracker)

        big_body = "log line\n" * 500
        state = {
            "messages": [
                HumanMessage(content="run", id="h-1"),
                _tool_msg(msg_id="t-1", content=big_body),
            ]
        }
        with caplog.at_level("WARNING"):
            result = await guard(state)

        assert "messages" in result  # budget updates still returned
        assert any("tracker emit failed" in r.getMessage() for r in caplog.records)


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
    async def test_raises_when_source_lacks_default_policy(self, model_id):
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
            await guard(state)
