# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ToolOutput guard adapter for compacting tool result messages (T2).

This module provides the ToolOutputGuardAdapter that renders tool output
messages into a compact string format with configurable truncation.
"""

from __future__ import annotations

import json
import re
from typing import Any, TypedDict

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.guard.types import DEFAULT_EMERGENCY_RATIO, TruncationPolicy
from chat_shell.guard_flags import BYPASS_COMPACTION_FLAG

COMPACTED_FLAG = "compacted"
HEADER_PREFIX = "[tool_output "
HEAD_RATIO = 0.6

_FOOTER_PATTERN = re.compile(r"^\[(exit_code=-?\d+)?( ?wall_time=\d+\.\d+s)?\]$")
_DIRECT_INJECTION_TOOL_NAME = "knowledge_base_search"
_DIRECT_INJECTION_MODE = "direct_injection"


class RawToolOutput(TypedDict, total=False):
    text: str
    tool_name: str
    exit_code: int
    wall_time: float


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _sanitize_name(name: str) -> str:
    """Sanitize tool name: replace whitespace with ``_``, strip ``]`` chars.

    Returns ``"unknown"`` when *name* is empty.
    """
    if not name:
        return "unknown"
    name = re.sub(r"\s", "_", name)
    name = name.replace("]", "")
    return name


def _parse_header(line: str) -> dict[str, str]:
    """Parse a header line like ``[tool_output name=xxx total_tokens=123 truncated=true]``.

    Returns a dict with keys ``name``, ``total_tokens``, ``truncated``.
    """
    inner = line[len(HEADER_PREFIX) :].rstrip("]")
    result: dict[str, str] = {}
    for part in inner.split():
        if "=" in part:
            key, val = part.split("=", 1)
            result[key] = val
    return result


def _is_footer_line(line: str) -> bool:
    """True iff `line` matches the exact format produced by `_build_footer`."""
    if not _FOOTER_PATTERN.match(line):
        return False
    # Empty bracket "[]" matches the regex but isn't a real footer
    return line != "[]"


def _parse_footer(line: str) -> dict[str, int | float]:
    """Parse a footer line like ``[exit_code=0 wall_time=1.2s]``.

    Returns a dict with optional keys ``exit_code`` (int) and ``wall_time`` (float).
    Missing/unparseable fields are simply omitted.
    """
    inner = line[1:-1]
    result: dict[str, int | float] = {}
    for part in inner.split():
        if part.startswith("exit_code="):
            try:
                result["exit_code"] = int(part.split("=", 1)[1])
            except (ValueError, IndexError):
                pass
        elif part.startswith("wall_time="):
            val = part.split("=", 1)[1]
            if val.endswith("s"):
                val = val[:-1]
            try:
                result["wall_time"] = float(val)
            except (ValueError, IndexError):
                pass
    return result


def _build_header(
    name: str,
    total_tokens: int,
    truncated: bool,
    *,
    extra_fields: dict[str, int | str] | None = None,
) -> str:
    """Build the header line."""
    parts = [
        f"[tool_output name={name}",
        f"total_tokens={total_tokens}",
    ]
    if truncated:
        for key, value in (extra_fields or {}).items():
            parts.append(f"{key}={value}")
    parts.append(f"truncated={'true' if truncated else 'false'}]")
    return " ".join(parts)


def _build_footer(exit_code: int | None, wall_time: float | None) -> str | None:
    """Build the footer line, or None if no metadata is present."""
    if exit_code is None and wall_time is None:
        return None
    parts: list[str] = []
    if exit_code is not None:
        parts.append(f"exit_code={exit_code}")
    if wall_time is not None:
        parts.append(f"wall_time={wall_time:.1f}s")
    return "[" + " ".join(parts) + "]"


def _parse_json_object(content: str) -> dict[str, Any] | None:
    """Parse *content* as a JSON object, returning ``None`` on failure."""
    try:
        parsed = json.loads(content)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _split_compact(content: str) -> tuple[str, str, dict[str, int | float]]:
    """Parse a compact string produced by this adapter into its constituents.

    *content* must start with :data:`HEADER_PREFIX`. Returns
    ``(body, tool_name, footer_info)`` where:

    * ``body`` — the wrapped body text, without the surrounding header/footer
    * ``tool_name`` — the ``name=`` value from the header (``""`` if absent)
    * ``footer_info`` — ``exit_code`` / ``wall_time`` parsed from the footer,
      or empty when the compact string had no footer.

    Used to recover the original body so a subsequent re-render under a
    stricter (emergency) policy doesn't end up wrapping a previous compact
    string and producing nested headers.
    """
    lines = content.split("\n")
    header_info = _parse_header(lines[0])
    tool_name = header_info.get("name", "")

    body_lines = lines[1:]
    footer_info: dict[str, int | float] = {}
    if body_lines and _is_footer_line(body_lines[-1]):
        footer_info = _parse_footer(body_lines[-1])
        body = "\n".join(body_lines[:-1])
    else:
        body = "\n".join(body_lines)

    return body, tool_name, footer_info


def _truncate_body(
    body: str, policy: TruncationPolicy, counter: TokenCounter
) -> tuple[str, int, bool, dict[str, int]]:
    """Truncate *body* according to *policy*.

    Returns:
        ``(rendered_body, total_input_tokens, truncated_flag, header_fields)``.
    """
    if policy.kind == "tokens":
        ids = counter.encoding.encode(body, disallowed_special=())
        total_tokens = len(ids)
        if total_tokens <= policy.limit:
            return (
                body,
                total_tokens,
                False,
                {
                    "kept_tokens": total_tokens,
                    "truncated_tokens": 0,
                },
            )
        head_budget = max(1, int(policy.limit * HEAD_RATIO))
        head_budget = min(head_budget, policy.limit)
        tail_budget = max(0, policy.limit - head_budget)
        head = counter.encoding.decode(ids[:head_budget])
        tail = counter.encoding.decode(ids[-tail_budget:]) if tail_budget > 0 else ""
        kept = head_budget + tail_budget
        dropped = total_tokens - kept
        marker = f"…{dropped} tokens truncated…"
        return (
            f"{marker}\n{head}\n{marker}\n{tail}",
            total_tokens,
            True,
            {
                "kept_tokens": kept,
                "truncated_tokens": dropped,
            },
        )

    elif policy.kind == "bytes":
        total_tokens = counter.count_text(body)
        encoded = body.encode("utf-8")
        total_bytes = len(encoded)
        if total_bytes <= policy.limit:
            return (
                body,
                total_tokens,
                False,
                {
                    "kept_bytes": total_bytes,
                    "truncated_bytes": 0,
                },
            )
        head_budget = max(1, int(policy.limit * HEAD_RATIO))
        head_budget = min(head_budget, policy.limit)
        tail_budget = max(0, policy.limit - head_budget)
        head = encoded[:head_budget].decode("utf-8", errors="ignore")
        tail = (
            encoded[-tail_budget:].decode("utf-8", errors="ignore")
            if tail_budget > 0
            else ""
        )
        kept = head_budget + tail_budget
        dropped_bytes = total_bytes - kept
        marker = f"…{dropped_bytes} bytes truncated…"
        return (
            f"{marker}\n{head}\n{marker}\n{tail}",
            total_tokens,
            True,
            {
                "kept_bytes": kept,
                "truncated_bytes": dropped_bytes,
            },
        )

    else:
        raise ValueError(f"Unknown policy kind: {policy.kind}")


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class ToolOutputGuardAdapter:
    """Renders tool output messages into a compact string format."""

    name = "tool_output"

    def __init__(
        self,
        token_counter: TokenCounter,
        default_policy: TruncationPolicy,
        emergency_ratio: float = DEFAULT_EMERGENCY_RATIO,
        tool_policy_overrides: dict[str, TruncationPolicy] | None = None,
    ) -> None:
        self._counter = token_counter
        self.default_policy = default_policy
        self._emergency_ratio = emergency_ratio
        self._tool_policy_overrides = dict(tool_policy_overrides or {})

    # -- GuardSource Protocol surface ----------------------------------------

    def to_model_visible(self, raw: Any, policy: TruncationPolicy) -> str:
        """Render *raw* tool output into a compact model-visible string.

        *raw* accepts either a ``RawToolOutput`` dict (with at least a ``text``
        str field) or a ``str`` (possibly a previously-compact string).
        """
        # Resolve body + metadata from the input shape.
        if isinstance(raw, dict):
            body = str(raw.get("text", ""))
            tool_name = raw.get("tool_name", "")
            exit_code = raw.get("exit_code")
            wall_time = raw.get("wall_time")
        elif isinstance(raw, str):
            if raw.startswith(HEADER_PREFIX):
                body, tool_name, footer_info = _split_compact(raw)
                exit_code = footer_info.get("exit_code")
                wall_time = footer_info.get("wall_time")
            else:
                body = raw
                tool_name = ""
                exit_code = None
                wall_time = None
        else:
            body = str(raw)
            tool_name = ""
            exit_code = None
            wall_time = None

        # Truncate and assemble.
        rendered_body, total_tokens, truncated, header_fields = _truncate_body(
            body, policy, self._counter
        )

        name = _sanitize_name(tool_name)
        header = _build_header(
            name,
            total_tokens,
            truncated,
            extra_fields=header_fields,
        )
        parts = [header, rendered_body]

        footer = _build_footer(exit_code, wall_time)
        if footer is not None:
            parts.append(footer)

        return "\n".join(parts)

    def emergency_policy(self, normal: TruncationPolicy) -> TruncationPolicy:
        """Return a reduced policy for emergency (memory-pressure) conditions.

        Uses the per-instance ``emergency_ratio`` (default
        :data:`DEFAULT_EMERGENCY_RATIO`), with a floor of 1 unit so the policy
        is always renderable.
        """
        return TruncationPolicy(
            kind=normal.kind,
            limit=max(1, int(normal.limit * self._emergency_ratio)),
        )

    def policy_for_message(self, message: dict[str, Any]) -> TruncationPolicy:
        """Resolve the normal truncation policy for a specific tool message."""
        tool_name = str(message.get("name") or "").strip()
        return self._tool_policy_overrides.get(tool_name, self.default_policy)

    def should_bypass_source_compaction(self, message: dict[str, Any]) -> bool:
        """Return True when source-level tool truncation should be skipped.

        ``knowledge_base_search`` direct-injection payloads are all-or-nothing:
        once the injected body is cut in the middle, the current system does not
        provide a stable way for the model to recover the omitted portion. Those
        payloads therefore bypass the per-tool truncation stage and rely on the
        request-level guard as the remaining safety net.
        """
        return self.should_bypass_request_compaction(message)

    def should_bypass_request_compaction(self, message: dict[str, Any]) -> bool:
        """Return True when request-level compaction must not mutate *message*.

        Today this protects knowledge-base direct-injection payloads: once the
        injected body is cut in the middle, the current system has no stable way
        to reconstruct the omitted portion for the model.
        """
        tool_name = str(message.get("name") or "").strip()
        if tool_name != _DIRECT_INJECTION_TOOL_NAME:
            return False

        payload = _parse_json_object(str(message.get("content", "")))
        if payload is None:
            return False

        return payload.get("mode") == _DIRECT_INJECTION_MODE

    # -- Recognition helpers (used by UnifiedContextGuard / T3) --------------

    def applies_to(self, message: dict[str, Any]) -> bool:
        """Return True if *message* is a tool result message."""
        return message.get("type") == "tool" or message.get("role") == "tool"

    def is_already_compact(self, message: dict[str, Any]) -> bool:
        """Return True if *message* has already been compacted."""
        return message.get("additional_kwargs", {}).get(COMPACTED_FLAG) is True

    def extract_raw(self, message: dict[str, Any]) -> RawToolOutput:
        """Extract a ``RawToolOutput`` dict from a tool message.

        If the message content is already a compact string produced by this
        adapter, parse the original body back out so a subsequent re-render
        under a stricter (emergency) policy operates on the original text
        rather than wrapping the previous compact form (which would yield
        nested headers and a fabricated ``total_tokens`` count).
        """
        result: dict[str, Any] = {}
        content = str(message.get("content", ""))

        if content.startswith(HEADER_PREFIX):
            body, header_tool_name, footer_info = _split_compact(content)
            result["text"] = body
            if header_tool_name:
                result["tool_name"] = header_tool_name
            if "exit_code" in footer_info:
                result["exit_code"] = footer_info["exit_code"]
            if "wall_time" in footer_info:
                result["wall_time"] = footer_info["wall_time"]
        else:
            result["text"] = content

        tool_name = message.get("name")
        if tool_name and isinstance(tool_name, str) and tool_name.strip():
            # message.name is authoritative when set — overrides any name
            # recovered from the compact header.
            result["tool_name"] = tool_name

        additional = message.get("additional_kwargs", {})
        if isinstance(additional, dict):
            exit_code = additional.get("exit_code")
            if exit_code is not None:
                try:
                    result["exit_code"] = int(exit_code)
                except (ValueError, TypeError):
                    pass

            wall_time = additional.get("wall_time")
            if wall_time is not None:
                try:
                    result["wall_time"] = float(wall_time)
                except (ValueError, TypeError):
                    pass

        return result
