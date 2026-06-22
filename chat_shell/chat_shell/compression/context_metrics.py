# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime context metrics for Chat Shell observability."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from copy import deepcopy
from dataclasses import asdict, dataclass
from typing import Any, Optional

from shared.models import ResponsesAPIEmitter

from .config import ModelContextConfig, get_model_context_config
from .token_counter import TokenCounter

logger = logging.getLogger(__name__)

PHASE_BUILD_MESSAGES = "build_messages"
PHASE_AFTER_TOOL_END = "after_tool_end"
PHASE_AFTER_COMPACTION = "after_compaction"
PHASE_FINAL = "final"
STATUS_UPDATE_STEP_PERCENT = 5


@dataclass
class ProviderUsageBaseline:
    """Observed provider input-token usage for a previously executed prompt."""

    input_tokens: int
    messages: list[dict[str, Any]]


@dataclass
class ContextMetricsSnapshot:
    """A single context usage snapshot."""

    context_window: int
    reserved_output_tokens: int
    available_input_tokens: int
    used_input_tokens: int
    remaining_input_tokens: int
    remaining_percent: int
    display_remaining_tokens: int
    display_remaining_percent: int
    trigger_limit: int
    target_limit: int
    is_over_trigger: bool

    def to_dict(self) -> dict[str, Any]:
        """Convert snapshot to a JSON-serializable dictionary."""
        return asdict(self)


@dataclass
class ContextCompactionEvent:
    """Transient runtime event describing a summary-compaction lifecycle step."""

    type: str
    status: str
    before_tokens: int
    trigger_limit: int
    target_limit: int
    used_legacy_fallback: bool
    created_at: str
    after_tokens: int | None = None
    summary_message_id: str | None = None
    failure_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        return {key: value for key, value in payload.items() if value is not None}


_BASELINE_FIELDS = ("role", "content", "tool_calls", "name", "tool_call_id")


def _baseline_message_shape(message: dict[str, Any]) -> tuple[Any, ...]:
    """Project a message dict to the stable shape used for baseline matching."""
    return tuple(deepcopy(message.get(field)) for field in _BASELINE_FIELDS)


def calculate_context_metrics(
    messages: list[dict[str, Any]],
    *,
    model_id: str,
    model_type: str | None = None,
    model_config: Optional[dict[str, Any]] = None,
    token_counter: TokenCounter | None = None,
    context_config: ModelContextConfig | None = None,
    usage_baseline: ProviderUsageBaseline | None = None,
) -> ContextMetricsSnapshot:
    """Calculate context metrics for the provided messages.

    *token_counter* and *context_config* may be supplied by callers that
    already hold cached instances (e.g. :class:`UnifiedContextGuard`), to
    avoid rebuilding them on every snapshot. When omitted, fresh ones are
    constructed from *model_id* / *model_config*.
    """
    if context_config is None:
        context_config = get_model_context_config(model_id, model_config=model_config)
    if token_counter is None:
        token_counter = TokenCounter(model_name=model_id, model_type=model_type)
    used_input_tokens = _estimate_used_input_tokens(
        messages,
        token_counter=token_counter,
        usage_baseline=usage_baseline,
    )
    available_input_tokens = max(0, context_config.available_tokens)
    remaining_input_tokens = max(0, available_input_tokens - used_input_tokens)
    remaining_percent = (
        int((remaining_input_tokens / available_input_tokens) * 100)
        if available_input_tokens > 0
        else 0
    )
    display_remaining_tokens = max(0, context_config.context_window - used_input_tokens)
    display_remaining_percent = (
        int((display_remaining_tokens / context_config.context_window) * 100)
        if context_config.context_window > 0
        else 0
    )

    return ContextMetricsSnapshot(
        context_window=context_config.context_window,
        reserved_output_tokens=context_config.reserved_output_tokens,
        available_input_tokens=available_input_tokens,
        used_input_tokens=used_input_tokens,
        remaining_input_tokens=remaining_input_tokens,
        remaining_percent=remaining_percent,
        display_remaining_tokens=display_remaining_tokens,
        display_remaining_percent=display_remaining_percent,
        trigger_limit=context_config.trigger_limit,
        target_limit=context_config.target_limit,
        is_over_trigger=used_input_tokens >= context_config.trigger_limit,
    )


def _message_prefix_matches(
    messages: list[dict[str, Any]],
    prefix: list[dict[str, Any]],
) -> bool:
    """Return True when *prefix* matches the head of *messages* exactly."""
    if len(messages) < len(prefix):
        return False
    return [
        _baseline_message_shape(message) for message in messages[: len(prefix)]
    ] == [_baseline_message_shape(message) for message in prefix]


def _estimate_used_input_tokens(
    messages: list[dict[str, Any]],
    *,
    token_counter: TokenCounter,
    usage_baseline: ProviderUsageBaseline | None,
) -> int:
    """Estimate current prompt usage with optional provider-observed baseline."""
    if usage_baseline is None or not _message_prefix_matches(
        messages, usage_baseline.messages
    ):
        return token_counter.count_messages(messages)

    delta_messages = messages[len(usage_baseline.messages) :]
    delta_tokens = token_counter.count_messages(delta_messages) if delta_messages else 0
    return usage_baseline.input_tokens + delta_tokens


def should_emit_status_update(
    previous: ContextMetricsSnapshot | None,
    current: ContextMetricsSnapshot,
    *,
    phase: str,
) -> bool:
    """Apply socket emission throttling rules for status updates."""
    if phase in {PHASE_BUILD_MESSAGES, PHASE_FINAL, PHASE_AFTER_COMPACTION}:
        return True

    if previous is None:
        return True

    if previous.is_over_trigger != current.is_over_trigger:
        return True

    previous_bucket = previous.remaining_percent // STATUS_UPDATE_STEP_PERCENT
    current_bucket = current.remaining_percent // STATUS_UPDATE_STEP_PERCENT
    return current_bucket < previous_bucket


class ContextMetricsTracker:
    """Emit-only wrapper that snapshots context usage at well-defined boundaries.

    The tracker does not maintain its own copy of the message list. Callers
    pass the messages they want measured at each :meth:`capture` call, so the
    snapshot always reflects the actual model-visible state at that moment.
    Snapshot calculation is delegated to *metrics_fn* (typically
    :meth:`UnifiedContextGuard.metrics`) so accounting flows from a single
    source of truth.
    """

    def __init__(
        self,
        *,
        task_id: int,
        subtask_id: int,
        metrics_fn: Callable[..., ContextMetricsSnapshot],
        emitter: ResponsesAPIEmitter,
    ) -> None:
        self.task_id = task_id
        self.subtask_id = subtask_id
        self._metrics_fn = metrics_fn
        self.emitter = emitter
        self.latest_snapshot: ContextMetricsSnapshot | None = None
        self.last_emitted_snapshot: ContextMetricsSnapshot | None = None
        self._usage_baseline: ProviderUsageBaseline | None = None

    async def capture(
        self,
        messages: list[dict[str, Any]],
        phase: str,
    ) -> ContextMetricsSnapshot:
        """Compute, log, and optionally emit a context metrics snapshot."""
        total_start = time.perf_counter()
        compute_start = time.perf_counter()
        baseline = self._usage_baseline
        if baseline is not None and not _message_prefix_matches(
            messages, baseline.messages
        ):
            self._usage_baseline = None
            baseline = None

        snapshot = self._metrics_fn(messages, usage_baseline=baseline)
        compute_ms = (time.perf_counter() - compute_start) * 1000
        self.latest_snapshot = snapshot

        logger.info(
            "[CONTEXT_METRICS] task_id=%d subtask_id=%d phase=%s used=%d available=%d "
            "remaining=%d remaining_percent=%d over_trigger=%s",
            self.task_id,
            self.subtask_id,
            phase,
            snapshot.used_input_tokens,
            snapshot.available_input_tokens,
            snapshot.remaining_input_tokens,
            snapshot.remaining_percent,
            snapshot.is_over_trigger,
        )

        emitted = False
        emit_ms = 0.0
        if should_emit_status_update(
            self.last_emitted_snapshot,
            snapshot,
            phase=phase,
        ):
            emit_start = time.perf_counter()
            await self.emitter.status_updated(
                phase=phase,
                context_metrics=snapshot.to_dict(),
            )
            emit_ms = (time.perf_counter() - emit_start) * 1000
            emitted = True
            self.last_emitted_snapshot = snapshot

        logger.info(
            "[CONTEXT_METRICS_PERF] task_id=%d subtask_id=%d phase=%s "
            "message_count=%d compute_ms=%.2f emit_ms=%.2f total_ms=%.2f emitted=%s",
            self.task_id,
            self.subtask_id,
            phase,
            len(messages),
            compute_ms,
            emit_ms,
            (time.perf_counter() - total_start) * 1000,
            emitted,
        )

        return snapshot

    def record_provider_usage(
        self,
        messages: list[dict[str, Any]],
        *,
        input_tokens: int,
    ) -> None:
        """Remember provider-observed prompt usage for the next pre-call estimate."""
        self._usage_baseline = ProviderUsageBaseline(
            input_tokens=input_tokens,
            messages=[
                {
                    field: deepcopy(message.get(field))
                    for field in _BASELINE_FIELDS
                    if field in message
                }
                for message in messages
            ],
        )

    def invalidate_provider_usage_baseline(self) -> None:
        """Drop the cached provider-usage baseline after non-append rewrites."""
        self._usage_baseline = None

    @property
    def usage_baseline(self) -> ProviderUsageBaseline | None:
        """Read-only access to the current provider-usage baseline."""
        return self._usage_baseline

    async def emit_status(
        self,
        *,
        phase: str,
        snapshot: ContextMetricsSnapshot,
        context_compaction: ContextCompactionEvent | None = None,
    ) -> None:
        """Emit an explicit status update without throttling.

        Used for transient runtime control-plane markers such as summary
        compaction start/completion/fallback, which the frontend should see
        immediately regardless of the normal bucket-throttling rules.
        """
        await self.emitter.status_updated(
            phase=phase,
            context_metrics=snapshot.to_dict(),
            context_compaction=(
                context_compaction.to_dict() if context_compaction is not None else None
            ),
        )
