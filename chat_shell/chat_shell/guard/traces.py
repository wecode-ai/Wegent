# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Span traces for the context-length protections.

One helper emits a uniformly-shaped span event for each of the three
protections (attachment preview, tool-output truncation, summary compact). A
consistent schema lets the tracing backend derive, per operation:

* **event count** — number of events,
* **success rate** — breakdown by ``status``,
* **duration** — ``duration_ms`` distribution,

plus token savings where applicable. All attribute values are primitives so
they are safe as OpenTelemetry event attributes; ``None`` values are dropped.
"""

from __future__ import annotations

from typing import Any

from shared.telemetry.decorators import add_span_event

EVENT_PREFIX = "context_protection"


def record_protection_trace(
    operation: str,
    status: str,
    *,
    duration_ms: float | None = None,
    before_tokens: int | None = None,
    after_tokens: int | None = None,
    **extra: Any,
) -> None:
    """Emit a span event for a context-protection operation.

    Args:
        operation: ``attachment_preview`` | ``tool_output`` | ``summary_compact``.
        status: outcome label, e.g. ``applied`` / ``noop`` / ``completed`` /
            ``fallback`` / ``error`` — used to compute success rate.
        duration_ms: wall time of the operation.
        before_tokens / after_tokens: token size before/after (adds
            ``tokens_saved`` when both are present).
        **extra: additional primitive attributes (None values are dropped).
    """
    attributes: dict[str, Any] = {"operation": operation, "status": status}
    if duration_ms is not None:
        attributes["duration_ms"] = round(duration_ms, 2)
    if before_tokens is not None:
        attributes["before_tokens"] = before_tokens
    if after_tokens is not None:
        attributes["after_tokens"] = after_tokens
    if before_tokens is not None and after_tokens is not None:
        attributes["tokens_saved"] = max(0, before_tokens - after_tokens)
    for key, value in extra.items():
        if value is not None:
            attributes[key] = value

    add_span_event(f"{EVENT_PREFIX}.{operation}", attributes)
