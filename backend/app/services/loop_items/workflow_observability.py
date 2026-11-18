# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Workflow counters and timings through the shared OpenTelemetry provider."""

import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.issue_workflow import WorkflowNodeInstance
from shared.telemetry.core import get_meter, is_telemetry_enabled
from shared.telemetry.decorators import add_span_event

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _instruments() -> dict[str, Any]:
    meter = get_meter("wegent.metrics")
    return {
        "events": meter.create_counter(
            "wegent.workflow.events", description="Workflow stage and gate events"
        ),
        "duration": meter.create_histogram(
            "wegent.workflow.stage.duration",
            unit="s",
            description="Workflow stage timing by phase",
        ),
        "violations": meter.create_counter(
            "wegent.workflow.invariant_violations",
            description="Workflow transitions violating a required gate",
        ),
    }


def record_workflow_event(
    event: str,
    *,
    node_id: str = "",
    strategy_id: str | None = None,
    source: str = "server",
    reason: str = "",
    count: int = 1,
    durations: dict[str, float] | None = None,
) -> None:
    attributes = {
        "event": event,
        "stage": node_id,
        "strategy": strategy_id or "custom",
        "source": source,
        "reason": reason,
    }
    logger.info(
        "[Workflow] event=%s stage=%s strategy=%s source=%s reason=%s count=%s durations=%s",
        event,
        node_id,
        strategy_id or "custom",
        source,
        reason,
        count,
        durations or {},
    )
    add_span_event("workflow." + event, {**attributes, "count": count})
    if not is_telemetry_enabled():
        return
    try:
        instruments = _instruments()
        instruments["events"].add(count, attributes)
        for phase, duration in (durations or {}).items():
            instruments["duration"].record(duration, {**attributes, "phase": phase})
    except Exception:
        logger.exception("[Workflow] telemetry export failed")


def record_workflow_invariant(reason: str, count: int, strategy_id: str | None) -> None:
    if count:
        logger.error(
            "[Workflow] invariant=%s count=%s strategy=%s", reason, count, strategy_id
        )
    if not is_telemetry_enabled():
        return
    try:
        _instruments()["violations"].add(
            count, {"reason": reason, "strategy": strategy_id or "custom"}
        )
    except Exception:
        logger.exception("[Workflow] invariant telemetry export failed")


def _seconds(start: datetime, end: datetime) -> float:
    def utc(value: datetime) -> datetime:
        return (
            value.replace(tzinfo=timezone.utc)
            if value.tzinfo is None
            else value.astimezone(timezone.utc)
        )

    return max(0.0, (utc(end) - utc(start)).total_seconds())


def stage_durations(
    db: Session, item: LoopItem, node: WorkflowNodeInstance, decided_at: datetime
) -> dict[str, float]:
    durations: dict[str, float] = {}
    if node.activated_at is not None:
        durations["activation_to_decision"] = _seconds(node.activated_at, decided_at)
        if node.attempts > 1:
            durations["rework_attempt"] = durations["activation_to_decision"]
    for index, entry in enumerate(node.state_history):
        if entry.get("attempt", node.attempts) != node.attempts:
            continue
        if entry.get("to") not in {"waiting", "blocked"}:
            continue
        started = datetime.fromisoformat(entry["at"])
        end = (
            datetime.fromisoformat(node.state_history[index + 1]["at"])
            if index + 1 < len(node.state_history)
            else decided_at
        )
        phase = "waiting" if entry["to"] == "waiting" else "blocked"
        duration = _seconds(started, end)
        if node.activated_at is not None:
            duration = max(0.0, duration - _seconds(started, node.activated_at))
        durations[phase] = durations.get(phase, 0.0) + duration
    if node.deliverables_completed_at is not None:
        durations["awaiting_approval"] = _seconds(
            node.deliverables_completed_at, decided_at
        )
        if node.activated_at is not None:
            durations["activation_to_deliverables"] = _seconds(
                node.activated_at, node.deliverables_completed_at
            )
    executions = (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .all()
    )
    matching = [
        execution
        for execution in executions
        if (
            execution.runtime_origin_context.get("workflow_stage_id") == node.id
            and execution.runtime_origin_context.get("workflow_attempt")
            == node.attempts
        )
    ]
    if matching:
        execution = max(matching, key=lambda entry: entry.id)
        if execution.started_at is not None:
            durations["execution"] = _seconds(
                execution.started_at, execution.completed_at or decided_at
            )
            if node.activated_at is not None:
                durations["waiting_for_execution"] = _seconds(
                    node.activated_at, execution.started_at
                )
        elif execution.queued_at is not None:
            durations["waiting_for_execution"] = _seconds(
                execution.queued_at, decided_at
            )
    return durations
