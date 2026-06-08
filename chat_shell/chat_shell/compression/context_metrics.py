# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime context metrics for Chat Shell observability."""

from __future__ import annotations

import logging
from collections.abc import Callable
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


def calculate_context_metrics(
    messages: list[dict[str, Any]],
    *,
    model_id: str,
    model_type: str | None = None,
    model_config: Optional[dict[str, Any]] = None,
    token_counter: TokenCounter | None = None,
    context_config: ModelContextConfig | None = None,
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
    used_input_tokens = token_counter.count_messages(messages)
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
        reserved_output_tokens=context_config.output_tokens,
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
        metrics_fn: Callable[[list[dict[str, Any]]], ContextMetricsSnapshot],
        emitter: ResponsesAPIEmitter,
    ) -> None:
        self.task_id = task_id
        self.subtask_id = subtask_id
        self._metrics_fn = metrics_fn
        self.emitter = emitter
        self.latest_snapshot: ContextMetricsSnapshot | None = None
        self.last_emitted_snapshot: ContextMetricsSnapshot | None = None

    async def capture(
        self,
        messages: list[dict[str, Any]],
        phase: str,
    ) -> ContextMetricsSnapshot:
        """Compute, log, and optionally emit a context metrics snapshot."""
        snapshot = self._metrics_fn(messages)
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

        if should_emit_status_update(
            self.last_emitted_snapshot,
            snapshot,
            phase=phase,
        ):
            await self.emitter.status_updated(
                phase=phase,
                context_metrics=snapshot.to_dict(),
            )
            self.last_emitted_snapshot = snapshot

        return snapshot
