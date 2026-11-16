# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Transactional Issue status events using the project event queue."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectAutomationRun,
    ProjectIncomingEvent,
    ProjectIncomingHook,
    loop_datetime_value_is_unset,
)
from app.services.project_automation_domain import ProjectAutomationEvent
from shared.telemetry.decorators import trace_async


def queue_issue_status_changed(
    db: Session,
    *,
    item: LoopItem,
    previous_status: str,
    actor_user_id: int | None = None,
    automation_run_id: str | None = None,
    automation_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> ProjectIncomingEvent | None:
    """Queue an actual transition atomically with the Issue's state update."""
    if item.status == previous_status:
        return
    from app.services.project_incoming_hooks import project_incoming_hook_service

    event_payload: dict[str, Any] = {
        **(payload or {}),
        "id": str(item.id),
        "title": item.title,
        "version": item.version,
        "status": item.status,
        "previous_status": previous_status,
        "priority": item.priority,
        "tags": item.tags,
        "status_history_length": len(
            (item.metadata_json or {}).get("status_history", [])
        ),
    }
    event_payload.pop("caused_by_automation_rule_id", None)
    run = db.get(ProjectAutomationRun, automation_run_id) if automation_run_id else None
    if run is not None:
        event_payload["caused_by_automation_rule_id"] = str(run.parent_id)
    return project_incoming_hook_service.queue_internal(
        db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=actor_user_id,
            payload=event_payload,
            event_id=(
                f"issue-status:{item.id}:{item.version}:"
                f"{previous_status}:{item.status}"
            ),
        ),
        automation_id=automation_id,
    )


def _status_is_current(db: Session, event: ProjectAutomationEvent) -> bool:
    item = db.get(LoopItem, event.subject_id)
    if (
        item is None
        or str(item.cloud_project_id) != event.project_id
        or not loop_datetime_value_is_unset(item.deleted_at)
        or item.status != event.payload.get("status")
    ):
        return False
    expected_sequence = event.payload.get("status_history_length")
    history = (item.metadata_json or {}).get("status_history", [])
    return expected_sequence is None or expected_sequence == len(history)


def _restore_event(
    row: ProjectIncomingEvent, hook: ProjectIncomingHook
) -> ProjectAutomationEvent:
    metadata = row.metadata_json or {}
    normalized = metadata["normalized_events"][0]
    subject = normalized["subject"]
    return ProjectAutomationEvent(
        event_type=normalized["event_type"],
        project_id=str(row.cloud_project_id),
        subject_id=str(subject["id"]),
        subject_type=subject["type"],
        source="wework",
        actor_user_id=metadata.get("actor_user_id"),
        payload=metadata["payload"],
        event_id=row.public_id,
        subscription_id=str(hook.id),
    )


def _finish_event(
    db: Session,
    row: ProjectIncomingEvent,
    *,
    status: str,
    reason: str | None = None,
    run_ids: list[str] | None = None,
) -> None:
    from app.services.project_incoming_hooks import project_incoming_hook_service

    project_incoming_hook_service._finish_event(
        db,
        str(row.id),
        status_value=status,
        normalized_events=(row.metadata_json or {}).get("normalized_events") or [],
        matched_runs=run_ids or [],
        reason=reason,
    )


@trace_async(
    span_name="project_automation.internal_event.process",
    tracer_name="backend.project_automation",
)
async def process_internal_event(
    db: Session, row: ProjectIncomingEvent, hook: ProjectIncomingHook
) -> int:
    """Restore a claimed internal event for the ordinary automation processor."""
    from app.services.project_automations import project_automation_processor

    event = _restore_event(row, hook)
    automation_id = (row.metadata_json or {}).get("automation_id")
    if event.event_type == "task.status_changed":
        if not _status_is_current(db, event):
            _finish_event(
                db,
                row,
                status="ignored",
                reason="Issue has left this status transition",
            )
            return 0
        if automation_id is None:
            matching = project_automation_processor.matching_rules(db, event)
            if len(matching) > 1:
                _finish_event(
                    db,
                    row,
                    status="unresolved",
                    reason="Multiple automations match this Issue",
                )
                return 0
            if matching:
                automation_id = str(matching[0].id)
    runs = await project_automation_processor.process_with_runs(
        db, event, automation_id=automation_id
    )
    run_ids = [str(run.id) for run in runs]
    _finish_event(
        db,
        row,
        status="processed",
        reason=None if run_ids else "No automation rule matched",
        run_ids=run_ids,
    )
    return len(runs)
