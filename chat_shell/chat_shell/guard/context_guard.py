# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""UnifiedContextGuard — single budget enforcement entry for chat_shell.

The guard is registered as LangGraph's ``pre_model_hook``. LangGraph fires the
hook before *every* model invocation inside ``create_react_agent``: the first
call of a turn and every follow-up after a tool. One hook covers both pre-turn
and mid-turn governance.

Pipeline (three stages, applied in order):

1. Source-level: convert raw payload from each registered ``GuardSource`` into a
   compact, model-visible representation and mark the message ``compacted``.
2. Request-level: if the live state still exceeds the model's trigger limit,
   run :class:`MessageCompressor` and translate its result into LangGraph state
   updates.
3. Emergency: if stage 2 is insufficient, re-render the largest source-owned
   messages under each source's emergency policy until the live state drops
   below trigger.

The hook returns a partial state update of the form
``{"messages": [RemoveMessage(...), ..., BaseMessage(...)]}`` consumed by the
``add_messages`` reducer. Messages with the same ``id`` upsert; new messages
without an existing ``id`` are appended.

When a :class:`ContextMetricsTracker` is wired in via :meth:`set_tracker`, the
guard also emits a context metrics snapshot after each invocation so the
frontend toolbar reflects mid-turn state changes (growth from new tool results,
shrinkage from compaction). Bucket-throttling in
:func:`should_emit_status_update` suppresses redundant emits when nothing
material changed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)

from chat_shell.compression.compressor import MessageCompressor
from chat_shell.compression.config import (
    ModelContextConfig,
    get_model_context_config,
)
from chat_shell.compression.context_metrics import (
    PHASE_AFTER_COMPACTION,
    PHASE_AFTER_TOOL_END,
    ContextCompactionEvent,
    ContextMetricsSnapshot,
    ContextMetricsTracker,
    ProviderUsageBaseline,
    _estimate_used_input_tokens,
    calculate_context_metrics,
)
from chat_shell.compression.summary_compactor import (
    SummaryCompactNotApplicable,
    SummaryCompactor,
)
from chat_shell.compression.token_counter import TokenCounter
from chat_shell.guard.tool_output import COMPACTED_FLAG
from chat_shell.guard.traces import record_protection_trace
from chat_shell.guard.types import GuardSource
from chat_shell.guard_flags import BYPASS_COMPACTION_FLAG

logger = logging.getLogger(__name__)


class ContextGuardFailFastError(RuntimeError):
    """Raised when the guard cannot safely reduce context below trigger."""


def _is_tool_output_truncated(source: GuardSource, compact_text: str) -> bool | None:
    """Return the explicit truncation flag encoded by known source formats.

    For ``tool_output`` we can reliably inspect the generated header line and
    surface a precise ``truncated=true/false`` signal in logs. Other sources do
    not currently expose a stable machine-readable truncation bit, so ``None``
    is returned for them.
    """
    if source.name != "tool_output":
        return None
    first_line = compact_text.split("\n", 1)[0]
    if " truncated=true]" in first_line:
        return True
    if " truncated=false]" in first_line:
        return False
    return None


# ---------------------------------------------------------------------------
# BaseMessage <-> dict conversion helpers (module-private)
# ---------------------------------------------------------------------------


def _role_for_message(msg: BaseMessage) -> str:
    """Return the canonical role string used by MessageCompressor / TokenCounter."""
    if isinstance(msg, SystemMessage):
        return "system"
    if isinstance(msg, HumanMessage):
        return "user"
    if isinstance(msg, AIMessage):
        return "assistant"
    if isinstance(msg, ToolMessage):
        return "tool"
    return getattr(msg, "type", "user")


def _basemessage_to_dict(msg: BaseMessage) -> dict[str, Any]:
    """Project a BaseMessage into the dict shape MessageCompressor expects.

    Only the fields the compressor and counter actually read are included; the
    ``id`` and ``additional_kwargs`` are preserved so we can map back after the
    pipeline runs.
    """
    payload: dict[str, Any] = {
        "role": _role_for_message(msg),
        "content": msg.content,
        "id": msg.id,
        "additional_kwargs": dict(getattr(msg, "additional_kwargs", {}) or {}),
    }
    name = getattr(msg, "name", None)
    if name:
        payload["name"] = name
    tool_call_id = getattr(msg, "tool_call_id", None)
    if tool_call_id:
        payload["tool_call_id"] = tool_call_id
    tool_calls = getattr(msg, "tool_calls", None)
    if tool_calls:
        payload["tool_calls"] = tool_calls
    return payload


def _state_messages_to_dicts(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    return [_basemessage_to_dict(m) for m in messages]


def _dict_to_state_message(d: dict[str, Any]) -> BaseMessage:
    """Convert a logical state dict back into a LangChain message."""
    role = d.get("role", "user")
    content = d.get("content", "")
    kwargs = dict(d.get("additional_kwargs") or {})
    id_kwargs: dict[str, Any] = {}
    msg_id = d.get("id")
    if msg_id:
        id_kwargs["id"] = msg_id

    if role == "assistant":
        return AIMessage(
            content=content,
            tool_calls=deepcopy(d.get("tool_calls") or []),
            additional_kwargs=kwargs,
            **id_kwargs,
        )
    if role == "system":
        return SystemMessage(content=content, additional_kwargs=kwargs, **id_kwargs)
    if role == "tool":
        return ToolMessage(
            content=content,
            tool_call_id=d.get("tool_call_id", ""),
            name=d.get("name"),
            additional_kwargs=kwargs,
            **id_kwargs,
        )
    return HumanMessage(content=content, additional_kwargs=kwargs, **id_kwargs)


def _message_fingerprint(message_dict: dict[str, Any]) -> tuple[Any, ...]:
    """Return a stable comparison tuple for state-diff decisions.

    ``MessageCompressor`` may mutate dicts in place, so the compression pass
    cannot compare by object identity or by re-reading the original dict after
    compression. The fingerprint captures the fields that affect model-visible
    state or later guard passes.
    """
    return (
        message_dict.get("role"),
        deepcopy(message_dict.get("content")),
        deepcopy(message_dict.get("tool_calls")),
        message_dict.get("name"),
        message_dict.get("tool_call_id"),
        deepcopy(message_dict.get("additional_kwargs") or {}),
    )


# ---------------------------------------------------------------------------
# UnifiedContextGuard
# ---------------------------------------------------------------------------


@dataclass
class _StagePass:
    """Internal: bundle a stage's state updates with its post-stage dict view.

    ``updates`` is the list of LangGraph state updates produced by the stage
    (RemoveMessage, replacement BaseMessage, or synthesized BaseMessage).
    ``view`` is the logical message list the next stage will reason about. For
    the source pass these are upserts so ``view`` is the same length as the
    input with replaced entries; for compression ``view`` is the new list
    returned by the compressor.
    """

    updates: list[Any] = field(default_factory=list)
    view: list[dict[str, Any]] = field(default_factory=list)


class UnifiedContextGuard:
    """Pre-model-call budget guard. Used as LangGraph ``pre_model_hook``.

    A single instance handles both pre-turn (turn start) and mid-turn (after
    every tool) invocations because LangGraph calls the hook before every
    model invocation inside the ReAct loop.

    Construct once per chat session and pass to ``AgentConfig.pre_model_hook``.
    """

    def __init__(
        self,
        *,
        model_id: str,
        model_type: str | None = None,
        model_config: dict[str, Any] | None = None,
        sources: list[GuardSource],
        compression_enabled: bool = True,
        tracker: ContextMetricsTracker | None = None,
        summary_compactor: SummaryCompactor | None = None,
    ) -> None:
        self._model_id = model_id
        self._model_type = model_type
        self._model_config = model_config
        self._sources = list(sources)
        self._counter = TokenCounter(model_name=model_id, model_type=model_type)
        self._ctx_config: ModelContextConfig = get_model_context_config(
            model_id, model_config=model_config
        )
        self._compressor: MessageCompressor | None = (
            MessageCompressor(model_id, model_config=model_config)
            if compression_enabled
            else None
        )
        self._tracker = tracker
        self._summary_compactor = summary_compactor
        self._context_compactions: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # LangGraph entry point
    # ------------------------------------------------------------------

    def set_tracker(self, tracker: ContextMetricsTracker | None) -> None:
        """Wire (or unwire) a metrics tracker post-construction.

        Provided as a setter because chat_service.py constructs the tracker
        with ``metrics_fn=guard.metrics`` and so cannot pass the tracker into
        ``__init__``. The tracker is optional — tests construct guards
        without one and the production code path tolerates ``None``.
        """
        self._tracker = tracker

    async def __call__(self, state: dict[str, Any]) -> dict[str, Any]:
        """LangGraph ``pre_model_hook`` callable.

        Returns ``{"messages": [...]}`` with state updates if the pipeline
        produced any; otherwise ``{}`` so LangGraph leaves state unchanged.

        When a tracker is wired in, also emits a context metrics snapshot
        for the post-enforcement view. Phase is ``PHASE_AFTER_COMPACTION``
        when this invocation actually compacted something (so the toolbar
        shows the bar shrinking), ``PHASE_AFTER_TOOL_END`` otherwise (where
        bucket-throttling decides whether the change is worth surfacing).
        Tracker emission failures are logged but never propagated — model
        execution must not depend on telemetry.
        """
        messages: list[BaseMessage] = state.get("messages", []) or []
        if not messages:
            return {}

        updates, post_view = await self._evaluate(messages)

        if self._tracker is not None:
            phase = PHASE_AFTER_COMPACTION if updates else PHASE_AFTER_TOOL_END
            try:
                if updates:
                    self._tracker.invalidate_provider_usage_baseline()
                await self._tracker.capture(post_view, phase)
            except Exception:
                logger.warning(
                    "[UnifiedContextGuard] tracker emit failed (phase=%s)",
                    phase,
                    exc_info=True,
                )

        if updates:
            return {"messages": updates}
        return {}

    # ------------------------------------------------------------------
    # Public test surface
    # ------------------------------------------------------------------

    def metrics(
        self,
        messages: list[dict[str, Any]],
        *,
        usage_baseline: ProviderUsageBaseline | None = None,
    ) -> ContextMetricsSnapshot:
        """Compute a context metrics snapshot for the given message dicts.

        Reuses the guard's pre-built ``TokenCounter`` and ``ModelContextConfig``
        so callers (e.g. :class:`ContextMetricsTracker`) don't pay the
        per-snapshot construction cost.
        """
        return calculate_context_metrics(
            messages,
            model_id=self._model_id,
            model_type=self._model_type,
            model_config=self._model_config,
            token_counter=self._counter,
            context_config=self._ctx_config,
            usage_baseline=usage_baseline,
        )

    @property
    def trigger_limit(self) -> int:
        return self._ctx_config.trigger_limit

    @property
    def target_limit(self) -> int:
        return self._ctx_config.target_limit

    @property
    def context_compactions(self) -> list[dict[str, Any]]:
        return list(self._context_compactions)

    @staticmethod
    def _compaction_created_at() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _current_usage_baseline(self) -> ProviderUsageBaseline | None:
        if self._tracker is None:
            return None
        baseline = self._tracker.usage_baseline
        if isinstance(baseline, ProviderUsageBaseline):
            return baseline
        return None

    def _current_used_input_tokens(self, view: list[dict[str, Any]]) -> int:
        return _estimate_used_input_tokens(
            view,
            token_counter=self._counter,
            usage_baseline=self._current_usage_baseline(),
        )

    async def _emit_context_compaction_status(
        self,
        *,
        phase: str,
        snapshot: ContextMetricsSnapshot,
        event: ContextCompactionEvent,
    ) -> None:
        if self._tracker is None:
            return
        logger.info(
            "[SummaryCompact] task_id=%d subtask_id=%d status=%s before=%d after=%s "
            "trigger=%d target=%d reserved_output=%d model_id=%s failure_reason=%s",
            self._tracker.task_id,
            self._tracker.subtask_id,
            event.status,
            event.before_tokens,
            event.after_tokens if event.after_tokens is not None else "-",
            event.trigger_limit,
            event.target_limit,
            snapshot.reserved_output_tokens,
            self._model_id,
            event.failure_reason or "-",
        )
        try:
            await self._tracker.emit_status(
                phase=phase,
                snapshot=snapshot,
                context_compaction=event,
            )
        except Exception:
            logger.warning(
                "[UnifiedContextGuard] tracker emit failed (phase=%s status=%s)",
                phase,
                event.status,
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Pipeline
    # ------------------------------------------------------------------

    async def _evaluate(
        self, messages: list[BaseMessage]
    ) -> tuple[list[Any], list[dict[str, Any]]]:
        """Three-stage pipeline.

        Returns ``(updates, post_view)`` where:

        * ``updates`` — the LangGraph state updates the hook will return
        * ``post_view`` — the dict-form view of state *after* all stages have
          applied; used to compute the post-enforcement metrics snapshot.
        """
        view = _state_messages_to_dicts(messages)
        self._mark_bypass_protection(view)
        all_updates: list[Any] = []

        # Stage 1: source-level passes (always runs; cheap when nothing to do).
        stage1 = self._apply_source_pass(view, messages, emergency=False)
        all_updates.extend(stage1.updates)
        view = stage1.view

        # Stage 2: request-level compaction — only if live state is over trigger.
        if self._is_over_trigger(view):
            stage2 = await self._apply_summary_compaction_pass(view, messages)
            all_updates.extend(stage2.updates)
            view = stage2.view

            if self._compressor is not None and (
                not stage2.updates or self._is_over_trigger(view)
            ):
                stage2_fallback = self._apply_compression_pass(view)
                all_updates.extend(stage2_fallback.updates)
                view = stage2_fallback.view
                if stage2_fallback.updates and self._context_compactions:
                    latest = self._context_compactions[-1]
                    if latest.get("type") == "summary_compact":
                        latest["used_legacy_fallback"] = True

        # Stage 3: emergency re-truncation. Attack the biggest source-owned
        # messages first under each source's emergency policy and stop as soon
        # as live state drops below trigger.
        if self._is_over_trigger(view):
            stage3 = self._apply_emergency_pass(view, messages)
            all_updates.extend(stage3.updates)
            view = stage3.view

            if self._is_over_trigger(view):
                logger.warning(
                    "[UnifiedContextGuard] Live state still over trigger after "
                    "emergency pass (used=%d, trigger=%d). No further reductions "
                    "available from registered sources.",
                    self._current_used_input_tokens(view),
                    self.trigger_limit,
                )
                if self._has_bypass_protected_messages(view):
                    protected_count = sum(
                        1
                        for message_dict in view
                        if (
                            isinstance(message_dict.get("additional_kwargs"), dict)
                            and message_dict["additional_kwargs"].get(
                                BYPASS_COMPACTION_FLAG
                            )
                            is True
                        )
                    )
                    logger.error(
                        "[UnifiedContextGuard] Fail-fast: protected payloads "
                        "prevent further safe compaction (used=%d, trigger=%d, "
                        "protected_messages=%d)",
                        self._current_used_input_tokens(view),
                        self.trigger_limit,
                        protected_count,
                    )
                    raise ContextGuardFailFastError(
                        "Current context still exceeds the safe input budget "
                        "after compaction, and at least one protected payload "
                        "cannot be truncated safely. Narrow the request or "
                        "avoid direct injection for this turn."
                    )

        return all_updates, view

    def _mark_bypass_protection(self, view: list[dict[str, Any]]) -> None:
        """Stamp bypass-protected messages so later stages can skip them.

        This converts source-specific detection into a generic per-message flag
        consumed by request-level strategies and the final fail-fast check.
        """
        if not self._sources:
            return

        for source in self._sources:
            marked_count = 0
            bypass_check = getattr(source, "should_bypass_request_compaction", None)
            if bypass_check is None:
                continue
            for message_dict in view:
                if not source.applies_to(message_dict):
                    continue
                if not bypass_check(message_dict):
                    continue
                kwargs = dict(message_dict.get("additional_kwargs") or {})
                kwargs[BYPASS_COMPACTION_FLAG] = True
                message_dict["additional_kwargs"] = kwargs
                marked_count += 1
            if marked_count > 0:
                logger.info(
                    "[UnifiedContextGuard] Marked %d bypass-protected message(s) "
                    "for source=%s",
                    marked_count,
                    source.name,
                )

    @staticmethod
    def _has_bypass_protected_messages(view: list[dict[str, Any]]) -> bool:
        """Return True when any post-stage message is marked bypass-protected."""
        for message_dict in view:
            kwargs = message_dict.get("additional_kwargs") or {}
            if isinstance(kwargs, dict) and kwargs.get(BYPASS_COMPACTION_FLAG) is True:
                return True
        return False

    # ------------------------------------------------------------------
    # Stage 1: source-level pass
    # ------------------------------------------------------------------

    def _apply_source_pass(
        self,
        view: list[dict[str, Any]],
        original_messages: list[BaseMessage],
        *,
        emergency: bool,
    ) -> _StagePass:
        """Run each registered source over the messages it owns.

        Non-emergency: skip messages already flagged ``compacted``.
        Emergency: re-render flagged messages too (caller decides policy).

        Messages without a stable ``id`` are skipped — without an id LangGraph's
        ``add_messages`` reducer would treat the replacement as a fresh append
        and the original would remain in state, doubling content.

        **Source disjointness assumption**: registered sources MUST have
        non-overlapping ``applies_to`` predicates — at most one source claims
        any given message. The inner loop iterates the *original* ``view``
        rather than ``new_view`` to keep each source's pass deterministic
        (stage-1 mutations to other messages don't perturb the iteration this
        source sees). The downside of that choice is that if two sources both
        claim the same message, the second source re-renders from raw and
        silently overwrites the first source's work. We rely on registration
        discipline rather than a runtime check — for a one-source-today
        deployment the cost of an overlap check isn't worth the indirection.
        """
        if not self._sources:
            return _StagePass(updates=[], view=list(view))

        started = time.perf_counter()
        updates: list[Any] = []
        new_view = list(view)
        idx_by_id: dict[str, int] = {
            d["id"]: i for i, d in enumerate(new_view) if d.get("id")
        }

        for source in self._sources:
            for i, message_dict in enumerate(view):
                if not source.applies_to(message_dict):
                    continue
                if hasattr(source, "should_bypass_source_compaction") and (
                    source.should_bypass_source_compaction(message_dict)
                ):
                    logger.debug(
                        "[UnifiedContextGuard] Source pass bypassed: source=%s "
                        "emergency=%s message_id=%s tool=%s",
                        source.name,
                        emergency,
                        message_dict.get("id"),
                        message_dict.get("name"),
                    )
                    continue
                if not emergency and source.is_already_compact(message_dict):
                    continue
                message_id = message_dict.get("id")
                if not message_id:
                    logger.warning(
                        "[UnifiedContextGuard] Skipping source pass on tool message "
                        "without id (cannot upsert safely). source=%s",
                        source.name,
                    )
                    continue

                raw = source.extract_raw(message_dict)
                policy = self._policy_for_source(
                    source,
                    message_dict=message_dict,
                    emergency=emergency,
                )
                compact_text = source.to_model_visible(raw, policy)
                original_content = message_dict.get("content", "")
                original_len = (
                    len(original_content)
                    if isinstance(original_content, str)
                    else len(str(original_content))
                )
                compacted_len = len(compact_text)
                truncated = _is_tool_output_truncated(source, compact_text)

                replacement = self._build_compact_replacement(
                    original=original_messages[i],
                    compact_text=compact_text,
                )
                updates.append(replacement)

                logger.info(
                    "[UnifiedContextGuard] Source pass applied: source=%s "
                    "emergency=%s message_id=%s tool=%s policy=%s:%d "
                    "truncated=%s chars=%d->%d",
                    source.name,
                    emergency,
                    message_id,
                    message_dict.get("name"),
                    policy.kind,
                    policy.limit,
                    truncated,
                    original_len,
                    compacted_len,
                )

                replaced_dict = dict(message_dict)
                replaced_dict["content"] = compact_text
                kwargs = dict(replaced_dict.get("additional_kwargs") or {})
                kwargs[COMPACTED_FLAG] = True
                replaced_dict["additional_kwargs"] = kwargs
                position = idx_by_id.get(message_id)
                if position is not None:
                    new_view[position] = replaced_dict

        if not updates:
            logger.debug(
                "[UnifiedContextGuard] Source pass made no changes "
                "(emergency=%s, sources=%d)",
                emergency,
                len(self._sources),
            )
        else:
            # Only trace when truncation actually happened — the pass runs before
            # every model call and is usually a no-op.
            record_protection_trace(
                "tool_output",
                "applied",
                duration_ms=(time.perf_counter() - started) * 1000,
                messages_truncated=len(updates),
                emergency=emergency,
            )

        return _StagePass(updates=updates, view=new_view)

    def _policy_for_source(
        self,
        source: GuardSource,
        *,
        message_dict: dict[str, Any],
        emergency: bool,
    ):
        """Resolve the policy a source should use this pass.

        Sources expose their normal policy as a public attribute
        ``default_policy``. Emergency wraps that through
        ``source.emergency_policy()``.
        """
        if hasattr(source, "policy_for_message"):
            normal = source.policy_for_message(message_dict)
        else:
            normal = getattr(source, "default_policy", None)
        if normal is None:
            raise ValueError(
                f"GuardSource {source.name!r} is missing 'default_policy'; "
                "the unified guard requires sources to expose one."
            )
        return source.emergency_policy(normal) if emergency else normal

    def _build_compact_replacement(
        self,
        *,
        original: BaseMessage,
        compact_text: str,
    ) -> BaseMessage:
        """Build a BaseMessage upsert carrying the compact text + flag.

        Caller must have already verified ``original.id`` is non-empty so the
        ``add_messages`` reducer can match this upsert against the existing
        message in state.
        """
        merged_kwargs = dict(getattr(original, "additional_kwargs", {}) or {})
        merged_kwargs[COMPACTED_FLAG] = True

        if isinstance(original, ToolMessage):
            return ToolMessage(
                content=compact_text,
                tool_call_id=original.tool_call_id,
                name=original.name,
                id=original.id,
                additional_kwargs=merged_kwargs,
            )
        return type(original)(
            content=compact_text,
            id=original.id,
            additional_kwargs=merged_kwargs,
        )

    # ------------------------------------------------------------------
    # Stage 2: request-level compression
    # ------------------------------------------------------------------

    async def _apply_summary_compaction_pass(
        self,
        view: list[dict[str, Any]],
        original_messages: list[BaseMessage],
    ) -> _StagePass:
        """Run summary compact as the primary request-level rewrite path."""
        if self._summary_compactor is None:
            return _StagePass(updates=[], view=view)

        before_tokens = self._current_used_input_tokens(view)
        before_snapshot = self.metrics(
            view,
            usage_baseline=self._current_usage_baseline(),
        )
        created_at = self._compaction_created_at()
        await self._emit_context_compaction_status(
            phase="summary_compact",
            snapshot=before_snapshot,
            event=ContextCompactionEvent(
                type="summary_compact",
                status="started",
                before_tokens=before_tokens,
                trigger_limit=self.trigger_limit,
                target_limit=self.target_limit,
                used_legacy_fallback=False,
                created_at=created_at,
            ),
        )
        compact_started = time.perf_counter()
        try:
            result = await self._summary_compactor.compact(
                [_dict_to_state_message(message_dict) for message_dict in view],
                preserve_initial_context=True,
            )
        except asyncio.CancelledError:
            # CancelledError is a BaseException; the ``except Exception`` below
            # would miss it and the compaction would vanish without a trace.
            logger.warning(
                "[UnifiedContextGuard] Summary compact cancelled after %.1fms "
                "(before_tokens=%d)",
                (time.perf_counter() - compact_started) * 1000,
                before_tokens,
            )
            raise
        except Exception as exc:
            failure_reason = (
                "summary_compact_not_applicable"
                if isinstance(exc, SummaryCompactNotApplicable)
                else "summary_compact_failed"
            )
            record_protection_trace(
                "summary_compact",
                "fallback",
                duration_ms=(time.perf_counter() - compact_started) * 1000,
                before_tokens=before_tokens,
                failure_reason=failure_reason,
                used_legacy_fallback=self._compressor is not None,
            )
            self._context_compactions.append(
                {
                    "strategy": "summary_compact",
                    "type": "summary_compact",
                    "status": "fallback",
                    "before_tokens": before_tokens,
                    "trigger_limit": self.trigger_limit,
                    "target_limit": self.target_limit,
                    "used_legacy_fallback": self._compressor is not None,
                    "failure_reason": failure_reason,
                    "created_at": created_at,
                }
            )
            await self._emit_context_compaction_status(
                phase="summary_compact",
                snapshot=before_snapshot,
                event=ContextCompactionEvent(
                    type="summary_compact",
                    status="fallback",
                    before_tokens=before_tokens,
                    trigger_limit=self.trigger_limit,
                    target_limit=self.target_limit,
                    used_legacy_fallback=self._compressor is not None,
                    created_at=created_at,
                    failure_reason=failure_reason,
                ),
            )
            logger.warning(
                "[UnifiedContextGuard] Summary compact failed; falling back to "
                "legacy request-level compression.",
                exc_info=True,
            )
            return _StagePass(updates=[], view=view)

        self._ensure_message_ids(original_messages)
        self._ensure_message_ids(result.replacement_history)
        replacement_view = _state_messages_to_dicts(result.replacement_history)
        after_tokens = self.metrics(replacement_view).used_input_tokens
        updates: list[Any] = [
            RemoveMessage(id=message.id) for message in original_messages
        ]
        updates.extend(result.replacement_history)

        summary_message_id = getattr(result.replacement_history[-1], "id", None)
        self._context_compactions.append(
            {
                "strategy": "summary_compact",
                "type": "summary_compact",
                "status": "completed",
                "before_tokens": before_tokens,
                "after_tokens": after_tokens,
                "trigger_limit": self.trigger_limit,
                "target_limit": self.target_limit,
                "used_legacy_fallback": False,
                "summary_message_id": summary_message_id,
                "created_at": created_at,
                "removed_history_items": result.removed_history_items,
            }
        )
        await self._emit_context_compaction_status(
            phase="summary_compact",
            snapshot=self.metrics(replacement_view),
            event=ContextCompactionEvent(
                type="summary_compact",
                status="completed",
                before_tokens=before_tokens,
                after_tokens=after_tokens,
                trigger_limit=self.trigger_limit,
                target_limit=self.target_limit,
                used_legacy_fallback=False,
                created_at=created_at,
                summary_message_id=summary_message_id,
            ),
        )
        record_protection_trace(
            "summary_compact",
            "completed",
            duration_ms=(time.perf_counter() - compact_started) * 1000,
            before_tokens=before_tokens,
            after_tokens=after_tokens,
            removed_history_items=result.removed_history_items,
        )
        logger.info(
            "[UnifiedContextGuard] Summary compact applied: %d -> %d tokens, "
            "removed_history_items=%d",
            before_tokens,
            after_tokens,
            result.removed_history_items,
        )
        return _StagePass(updates=updates, view=replacement_view)

    def _apply_compression_pass(self, view: list[dict[str, Any]]) -> _StagePass:
        """Run MessageCompressor and translate its diff into LangGraph updates."""
        assert self._compressor is not None  # Guarded by caller.

        before_fingerprints = {
            d["id"]: _message_fingerprint(d) for d in view if d.get("id")
        }
        result = self._compressor.compress_if_needed(view)
        if not result.was_compressed:
            return _StagePass(updates=[], view=view)

        before_ids = {d["id"] for d in view if d.get("id")}
        after_ids = {d.get("id") for d in result.messages if d.get("id")}

        updates: list[Any] = []

        # Drop messages whose ids disappeared from the compressed list.
        for dropped_id in before_ids - after_ids:
            updates.append(RemoveMessage(id=dropped_id))

        # Upsert changed retained messages and append synthesized messages.
        for compressed_dict in result.messages:
            compressed_id = compressed_dict.get("id")
            if compressed_id in before_ids:
                if before_fingerprints.get(compressed_id) == _message_fingerprint(
                    compressed_dict
                ):
                    continue  # unchanged passthrough — leave untouched
                updates.append(self._dict_to_base_message(compressed_dict))
                continue
            updates.append(self._dict_to_base_message(compressed_dict))

        logger.info(
            "[UnifiedContextGuard] Compression applied: "
            "%d -> %d tokens, dropped=%d, synthesized=%d, strategies=%s",
            result.original_tokens,
            result.compressed_tokens,
            len(before_ids - after_ids),
            len(updates) - len(before_ids - after_ids),
            ", ".join(result.strategies_applied),
        )

        return _StagePass(updates=updates, view=result.messages)

    @staticmethod
    def _dict_to_base_message(d: dict[str, Any]) -> BaseMessage:
        """Convert a compressor-produced dict back into a BaseMessage.

        Compressor synthesizes summary messages with role ``user`` or
        ``assistant``; mark them ``compacted=True`` so subsequent passes
        recognise them as already-compact.

        When the dict carries a non-empty ``id``, it is forwarded to the
        constructed message so the compressor's stable identity is preserved
        (LangChain would otherwise mint a fresh id, breaking later upserts via
        ``add_messages``).
        """
        role = d.get("role", "user")
        content = d.get("content", "")
        kwargs = dict(d.get("additional_kwargs") or {})
        kwargs[COMPACTED_FLAG] = True

        # Only pass id when explicitly set so the BaseMessage __init__ default
        # (auto-mint) still applies for synthesized messages without one.
        id_kwargs: dict[str, Any] = {}
        msg_id = d.get("id")
        if msg_id:
            id_kwargs["id"] = msg_id

        if role == "user":
            return HumanMessage(content=content, additional_kwargs=kwargs, **id_kwargs)
        if role == "assistant":
            return AIMessage(content=content, additional_kwargs=kwargs, **id_kwargs)
        if role == "system":
            return SystemMessage(content=content, additional_kwargs=kwargs, **id_kwargs)
        if role == "tool":
            return ToolMessage(
                content=content,
                tool_call_id=d.get("tool_call_id", ""),
                name=d.get("name"),
                additional_kwargs=kwargs,
                **id_kwargs,
            )
        return HumanMessage(content=content, additional_kwargs=kwargs, **id_kwargs)

    # ------------------------------------------------------------------
    # Stage 3: emergency re-truncation
    # ------------------------------------------------------------------

    def _apply_emergency_pass(
        self,
        view: list[dict[str, Any]],
        original_messages: list[BaseMessage],
    ) -> _StagePass:
        """Re-render the largest source-owned messages under emergency policy.

        Strategy: biggest content first (most reduction per operation), oldest
        first as tiebreaker. Stop as soon as ``count_messages(view)`` drops
        below the trigger limit. Skip rewrites that produce identical text
        (already at emergency level).

        Synthesized messages from the compression pass have ids that are not
        present in ``original_messages`` and so cannot be safely upserted via
        ``add_messages`` — those are excluded from the candidate set.
        """
        if not self._sources:
            return _StagePass(updates=[], view=list(view))

        id_to_original: dict[str, BaseMessage] = {
            m.id: m for m in original_messages if m.id
        }

        candidates: list[tuple[int, GuardSource]] = []
        for source in self._sources:
            for i, msg in enumerate(view):
                if not source.applies_to(msg):
                    continue
                kwargs = msg.get("additional_kwargs") or {}
                if (
                    isinstance(kwargs, dict)
                    and kwargs.get(BYPASS_COMPACTION_FLAG) is True
                ):
                    continue
                msg_id = msg.get("id")
                if not msg_id or msg_id not in id_to_original:
                    continue
                candidates.append((i, source))

        if not candidates:
            return _StagePass(updates=[], view=list(view))

        def content_len(idx: int) -> int:
            content = view[idx].get("content", "")
            return len(content) if isinstance(content, str) else len(str(content))

        candidates.sort(key=lambda pair: (-content_len(pair[0]), pair[0]))

        new_view = list(view)
        updates: list[Any] = []

        for idx, source in candidates:
            msg_dict = new_view[idx]
            raw = source.extract_raw(msg_dict)
            policy = self._policy_for_source(
                source,
                message_dict=msg_dict,
                emergency=True,
            )
            compact_text = source.to_model_visible(raw, policy)

            if compact_text == msg_dict.get("content"):
                continue

            original = id_to_original[msg_dict["id"]]
            replacement = self._build_compact_replacement(
                original=original, compact_text=compact_text
            )
            updates.append(replacement)

            replaced = dict(msg_dict)
            replaced["content"] = compact_text
            kwargs = dict(replaced.get("additional_kwargs") or {})
            kwargs[COMPACTED_FLAG] = True
            replaced["additional_kwargs"] = kwargs
            new_view[idx] = replaced

            if not self._is_over_trigger(new_view):
                break

        if updates:
            logger.info(
                "[UnifiedContextGuard] Emergency pass applied: rewrote %d message(s) "
                "under emergency policy.",
                len(updates),
            )

        return _StagePass(updates=updates, view=new_view)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _is_over_trigger(self, view: list[dict[str, Any]]) -> bool:
        return self._current_used_input_tokens(view) >= self.trigger_limit

    @staticmethod
    def _ensure_message_ids(messages: list[BaseMessage]) -> None:
        """Assign stable ids to messages that will participate in state rewrites."""
        for message in messages:
            if not getattr(message, "id", None):
                message.id = str(uuid4())
