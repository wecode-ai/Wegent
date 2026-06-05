# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime context metrics for Chat Shell observability."""

from __future__ import annotations

import json
import logging
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
) -> ContextMetricsSnapshot:
    """Calculate context metrics for the provided messages."""
    context_config = get_model_context_config(model_id, model_config=model_config)
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
    """Track model-visible context growth during a single Chat Shell turn."""

    def __init__(
        self,
        *,
        task_id: int,
        subtask_id: int,
        model_id: str,
        model_type: str | None,
        model_config: Optional[dict[str, Any]],
        emitter: ResponsesAPIEmitter,
    ) -> None:
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.model_id = model_id
        self.model_type = model_type
        self.model_config = model_config
        self.emitter = emitter
        self.messages: list[dict[str, Any]] = []
        self.latest_snapshot: ContextMetricsSnapshot | None = None
        self.last_emitted_snapshot: ContextMetricsSnapshot | None = None
        self._final_assistant_recorded = False

    async def initialize(
        self, messages: list[dict[str, Any]]
    ) -> ContextMetricsSnapshot:
        """Seed the tracker with the post-build message list."""
        self.messages = [self._clone_message(message) for message in messages]
        return await self.capture(PHASE_BUILD_MESSAGES)

    def record_tool_start(
        self,
        *,
        tool_use_id: str,
        tool_name: str,
        tool_input: Any,
    ) -> None:
        """Append a synthetic assistant tool-call message for observability."""
        arguments = self._stringify_json(tool_input)
        self.messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": tool_use_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": arguments,
                        },
                    }
                ],
            }
        )

    async def record_tool_end(
        self,
        *,
        tool_use_id: str,
        tool_name: str,
        tool_output: Any,
    ) -> ContextMetricsSnapshot:
        """Append a synthetic tool-result message and capture a snapshot."""
        self.messages.append(
            {
                "role": "tool",
                "tool_call_id": tool_use_id,
                "name": tool_name,
                "content": self._stringify_tool_output(tool_output),
            }
        )
        return await self.capture(PHASE_AFTER_TOOL_END)

    async def record_final_assistant_response(
        self, content: str
    ) -> ContextMetricsSnapshot:
        """Record the final assistant response before the turn completes."""
        if content and not self._final_assistant_recorded:
            self.messages.append({"role": "assistant", "content": content})
            self._final_assistant_recorded = True
        return await self.capture(PHASE_FINAL)

    async def capture(self, phase: str) -> ContextMetricsSnapshot:
        """Compute, log, and optionally emit a context metrics snapshot."""
        snapshot = calculate_context_metrics(
            self.messages,
            model_id=self.model_id,
            model_type=self.model_type,
            model_config=self.model_config,
        )
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

    @staticmethod
    def _clone_message(message: dict[str, Any]) -> dict[str, Any]:
        return dict(message)

    @staticmethod
    def _stringify_tool_output(tool_output: Any) -> str:
        if isinstance(tool_output, str):
            return tool_output
        return ContextMetricsTracker._stringify_json(tool_output)

    @staticmethod
    def _stringify_json(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False, default=str)
        except TypeError:
            return str(value)
