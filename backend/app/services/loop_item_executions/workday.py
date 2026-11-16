"""Apply persisted scheduled-run policy after execution claim authorization."""

from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import ProjectAutomationRun, loop_datetime_value_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.services.project_automation_domain import permits_scheduled_run

NON_WORKDAY_NOTE = (
    "Scheduled execution cancelled: today is not a China statutory workday"
)
INITIAL_RUN_STATUSES = {"pending", "queued", "waiting_runtime", "waiting_device"}


def _record_calendar_error(
    db: Session, execution: LoopItemExecution, detail: str, commit: bool
) -> None:
    if execution.error_message == detail:
        return
    db.query(LoopItemExecution).filter(
        LoopItemExecution.id == execution.id,
        LoopItemExecution.status == execution.status,
        LoopItemExecution.version == execution.version,
    ).update(
        {"error_message": detail, "execution_note": "workday_calendar_unavailable"},
        synchronize_session=False,
    )
    if commit:
        db.commit()
    else:
        db.flush()


def permits_execution_start(
    db: Session,
    execution: LoopItemExecution,
    at: datetime,
    *,
    commit: bool = True,
) -> bool:
    """Keep live sessions and comment continuations outside the calendar gate."""
    if (
        execution.status not in {"queued", "claimed"}
        or not loop_datetime_value_is_unset(execution.start_requested_at)
        or not execution.owns_automation_run
        or execution.runtime_origin_context.get("comment_trigger_message_id")
    ):
        return True
    run = db.get(ProjectAutomationRun, execution.automation_run_id)
    if run is None or run.status not in INITIAL_RUN_STATUSES:
        return True
    metadata = run.metadata_json or {}
    trigger = metadata.get("trigger") or run.source
    try:
        permitted = permits_scheduled_run(metadata, trigger, at)
    except HTTPException as exc:
        _record_calendar_error(db, execution, str(exc.detail), commit)
        return False
    if permitted:
        return True
    from app.services.loop_item_executions.service import loop_item_execution_service

    loop_item_execution_service.cancel(
        db,
        execution_id=execution.id,
        note=NON_WORKDAY_NOTE,
        expected_status=execution.status,
        expected_version=execution.version,
        commit=commit,
    )
    return False
