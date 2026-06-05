# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ToolOutputGuardAdapter (T2)."""

from __future__ import annotations

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.guard.tool_output import (
    HEADER_PREFIX,
    ToolOutputGuardAdapter,
)
from chat_shell.guard.types import TruncationPolicy

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tokens(n: int, counter: TokenCounter) -> str:
    """Generate text with exactly *n* tokens using cl100k encoding."""
    base = "The quick brown fox jumps over the lazy dog. " * ((n // 10) + 1)
    ids = counter.encoding.encode(base)
    return counter.encoding.decode(ids[:n])


def _make_adapter() -> ToolOutputGuardAdapter:
    """Create a default adapter with token limit 1000."""
    return ToolOutputGuardAdapter(
        token_counter=TokenCounter("gpt-4"),
        default_policy=TruncationPolicy(kind="tokens", limit=1000),
    )


# =============================================================================
# to_model_visible
# =============================================================================


class TestToModelVisible:
    def test_under_budget_no_truncation(self):
        """Body of 50 tokens under a 200-token policy — no truncation."""
        counter = TokenCounter("gpt-4")
        adapter = ToolOutputGuardAdapter(
            token_counter=counter,
            default_policy=TruncationPolicy(kind="tokens", limit=200),
        )
        body = _make_tokens(50, counter)
        policy = TruncationPolicy(kind="tokens", limit=200)

        output = adapter.to_model_visible({"text": body}, policy)

        lines = output.split("\n")
        assert lines[0] == (
            "[tool_output name=unknown total_tokens=50 truncated=false]"
        )
        assert "\n".join(lines[1:]) == body

    def test_over_token_budget_truncates_with_marker(self):
        """Body of ~500 tokens under a 100-token policy — truncated with marker."""
        counter = TokenCounter("gpt-4")
        adapter = ToolOutputGuardAdapter(
            token_counter=counter,
            default_policy=TruncationPolicy(kind="tokens", limit=100),
        )
        body = _make_tokens(500, counter)
        policy = TruncationPolicy(kind="tokens", limit=100)

        output = adapter.to_model_visible({"text": body}, policy)

        lines = output.split("\n")
        assert lines[0].startswith(HEADER_PREFIX)
        assert "truncated=true" in lines[0]
        assert "total_tokens=500" in lines[0]
        # Body contains the truncation marker
        body_text = "\n".join(lines[1:])
        assert "... [truncated " in body_text
        assert " tokens] ..." in body_text

    def test_with_metadata_emits_footer(self):
        """Raw dict with metadata — header and footer present."""
        adapter = _make_adapter()
        policy = TruncationPolicy(kind="tokens", limit=200)

        raw = {
            "text": "hello",
            "tool_name": "bash",
            "exit_code": 0,
            "wall_time": 1.234,
        }
        output = adapter.to_model_visible(raw, policy)

        lines = output.split("\n")
        assert lines[0] == ("[tool_output name=bash total_tokens=1 truncated=false]")
        assert lines[1] == "hello"
        assert lines[2] == "[exit_code=0 wall_time=1.2s]"

    def test_partial_metadata_emits_partial_footer(self):
        """Only one metadata field — footer contains only that field."""
        adapter = _make_adapter()
        policy = TruncationPolicy(kind="tokens", limit=200)

        # Only exit_code
        raw_exit = {"text": "x", "exit_code": 2}
        out1 = adapter.to_model_visible(raw_exit, policy)
        lines1 = out1.split("\n")
        assert lines1[-1] == "[exit_code=2]"

        # Only wall_time
        raw_wall = {"text": "x", "wall_time": 0.5}
        out2 = adapter.to_model_visible(raw_wall, policy)
        lines2 = out2.split("\n")
        assert lines2[-1] == "[wall_time=0.5s]"

    def test_idempotent_on_compact_string(self):
        """Render once, then re-render with same policy — output identical."""
        counter = TokenCounter("gpt-4")
        adapter = ToolOutputGuardAdapter(
            token_counter=counter,
            default_policy=TruncationPolicy(kind="tokens", limit=200),
        )
        body = _make_tokens(50, counter)
        policy = TruncationPolicy(kind="tokens", limit=200)

        first = adapter.to_model_visible({"text": body}, policy)
        second = adapter.to_model_visible(first, policy)

        assert second == first

    def test_re_truncates_compact_with_stricter_policy(self):
        """Render with 200-token policy, re-render with 50 — shorter output."""
        counter = TokenCounter("gpt-4")
        adapter = ToolOutputGuardAdapter(
            token_counter=counter,
            default_policy=TruncationPolicy(kind="tokens", limit=200),
        )
        body = _make_tokens(500, counter)

        first = adapter.to_model_visible(
            body, TruncationPolicy(kind="tokens", limit=200)
        )
        second = adapter.to_model_visible(
            first, TruncationPolicy(kind="tokens", limit=50)
        )

        assert "truncated=true" in second.split("\n")[0]
        assert len(second) < len(first)

    def test_bytes_policy_truncation(self):
        """Body of 10000 bytes under 200-byte policy — truncated with bytes marker."""
        counter = TokenCounter("gpt-4")
        adapter = ToolOutputGuardAdapter(
            token_counter=counter,
            default_policy=TruncationPolicy(kind="bytes", limit=200),
        )
        body = "x" * 10000
        policy = TruncationPolicy(kind="bytes", limit=200)

        output = adapter.to_model_visible({"text": body}, policy)

        lines = output.split("\n")
        assert "truncated=true" in lines[0]
        body_text = "\n".join(lines[1:])
        assert "... [truncated " in body_text
        assert " bytes] ..." in body_text

    def test_name_with_whitespace_is_sanitized(self):
        """tool_name with whitespace — replaced with underscores."""
        adapter = _make_adapter()
        policy = TruncationPolicy(kind="tokens", limit=200)

        raw = {"text": "hi", "tool_name": "my tool"}
        output = adapter.to_model_visible(raw, policy)

        assert output.split("\n")[0] == (
            "[tool_output name=my_tool total_tokens=1 truncated=false]"
        )

    def test_footer_pattern_rejects_malformed_value(self):
        """A body line that looks like a footer but has a non-numeric exit_code
        must be preserved on re-render, not dropped as a malformed footer."""
        adapter = _make_adapter()
        body = "log line 1\nlog line 2\n[exit_code=abc]"
        raw = {"text": body, "tool_name": "demo"}
        rendered = adapter.to_model_visible(
            raw, TruncationPolicy(kind="tokens", limit=200)
        )
        # Re-render should NOT lose the [exit_code=abc] line
        rerendered = adapter.to_model_visible(
            rendered, TruncationPolicy(kind="tokens", limit=200)
        )
        assert "[exit_code=abc]" in rerendered

    def test_footer_pattern_rejects_empty_brackets(self):
        """A body line `[]` must not be misdetected as a footer."""
        adapter = _make_adapter()
        body = "before\n[]\nafter"
        raw = {"text": body}
        rendered = adapter.to_model_visible(
            raw, TruncationPolicy(kind="tokens", limit=200)
        )
        rerendered = adapter.to_model_visible(
            rendered, TruncationPolicy(kind="tokens", limit=200)
        )
        assert "[]" in rerendered

    def test_footer_pattern_accepts_negative_exit_code(self):
        """Some shells return negative exit codes; the pattern must match them."""
        adapter = _make_adapter()
        raw = {"text": "ok", "exit_code": -1}
        rendered = adapter.to_model_visible(
            raw, TruncationPolicy(kind="tokens", limit=200)
        )
        assert "[exit_code=-1]" in rendered
        # And re-render preserves it
        rerendered = adapter.to_model_visible(
            rendered, TruncationPolicy(kind="tokens", limit=200)
        )
        assert "[exit_code=-1]" in rerendered


# =============================================================================
# applies_to / is_already_compact / extract_raw / emergency_policy
# =============================================================================


class TestRecognition:
    def test_applies_to_recognizes_both_shapes(self):
        """Both ``type=tool`` and ``role=tool`` messages are recognized."""
        adapter = _make_adapter()

        assert adapter.applies_to({"type": "tool"}) is True
        assert adapter.applies_to({"role": "tool"}) is True
        assert adapter.applies_to({"type": "ai"}) is False

    def test_is_already_compact_reads_flag(self):
        """``compacted`` flag in additional_kwargs controls compact state."""
        adapter = _make_adapter()

        assert (
            adapter.is_already_compact({"additional_kwargs": {"compacted": True}})
            is True
        )
        assert (
            adapter.is_already_compact({"additional_kwargs": {"compacted": False}})
            is False
        )
        assert adapter.is_already_compact({}) is False

    def test_extract_raw_pulls_fields(self):
        """Full message — all keys extracted. Missing fields are absent."""
        adapter = _make_adapter()
        msg = {
            "content": "result text",
            "name": "bash",
            "additional_kwargs": {
                "exit_code": 0,
                "wall_time": 1.5,
            },
        }

        raw = adapter.extract_raw(msg)
        assert raw["text"] == "result text"
        assert raw["tool_name"] == "bash"
        assert raw["exit_code"] == 0
        assert raw["wall_time"] == 1.5

        # Missing fields are absent from the dict.
        assert "tool_name" not in adapter.extract_raw({"content": "x"})
        assert "exit_code" not in adapter.extract_raw({"content": "x"})

    def test_emergency_policy_is_default_helper(self):
        """Emergency policy is 30 % of normal, floor 1."""
        adapter = _make_adapter()
        emergency = adapter.emergency_policy(TruncationPolicy(kind="tokens", limit=100))
        assert emergency.kind == "tokens"
        assert emergency.limit == 30
