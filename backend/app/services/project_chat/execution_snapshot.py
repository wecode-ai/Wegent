"""Reconcile persisted execution projections after reading Runtime history.

Reports contain identities and outcomes only, never conversation contents.
They repair execution state without replaying business workflow callbacks.
"""

from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import String, cast
from sqlalchemy.orm import Query, Session

from app.db.timezone import database_datetime_timezone
from app.models.delivery import LoopItem, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import ProjectChatMessageView
from app.schemas.runtime_execution_snapshot import (
    RuntimeExecutionSnapshot,
    RuntimeExecutionTurnSnapshot,
)
from app.services.device.identity import (
    device_identity_ids,
    resolve_owned_device_alias,
)
from app.services.project_chat.service import project_chat_service

TERMINAL_STATUSES = {"done": "completed", "failed": "failed", "cancelled": "cancelled"}


@dataclass(frozen=True)
class CompletedTurnContentProjection:
    handled: bool
    projection: tuple[ProjectChatMessageView, str] | None = None


def restore_completed_turn_content(
    db: Session,
    *,
    device_ids: list[str],
    task_id: str,
    payload: dict,
    owner_user_id: int | None = None,
    execution_id: int | None = None,
) -> CompletedTurnContentProjection:
    """Consume an exact completed turn without replaying business workflow."""
    turn_id = payload.get("subtaskId") or payload.get("subtask_id")
    if not isinstance(turn_id, str) or not turn_id:
        return CompletedTurnContentProjection(False)
    execution = None
    if execution_id is not None:
        # The event may have read an active root before a concurrent snapshot
        # committed. Use current reads after locking that known aggregate.
        execution = _lock_content_execution(db, execution_id)
    else:
        candidate = _completed_activity_query(
            db, device_ids, task_id, turn_id
        ).one_or_none()
        if candidate is None:
            return CompletedTurnContentProjection(False)
        execution_id = (candidate.metadata_json or {}).get("execution_id")
        if execution_id:
            execution = _lock_content_execution(db, execution_id)
    query = _completed_activity_query(db, device_ids, task_id, turn_id)
    if execution_id:
        query = query.filter(
            cast(ProjectChatMessage.metadata_json["execution_id"].as_string(), String)
            == str(execution_id)
        )
    row = query.populate_existing().with_for_update().one_or_none()
    if row is None:
        return CompletedTurnContentProjection(execution_id is not None)
    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    content = project_chat_service._project_chat_final_text(data, payload)
    sequence = _completed_content_sequence(payload)
    if content is None or (
        execution_id
        and not _accept_completed_content(execution, row, sequence, owner_user_id)
    ):
        return CompletedTurnContentProjection(True)
    row.content = content
    project_chat_service._index_activity_change_requests(db, row)
    if execution is not None:
        execution.last_event_seq = sequence
    project_chat_service._commit(db)
    db.refresh(row)
    return CompletedTurnContentProjection(
        True, (project_chat_service.to_view(row, db=db), "snapshot")
    )


def _completed_activity_query(
    db: Session, device_ids: list[str], task_id: str, turn_id: str
) -> Query[ProjectChatMessage]:
    return db.query(ProjectChatMessage).filter(
        ProjectChatMessage.runtime_device_id.in_(device_ids),
        ProjectChatMessage.runtime_task_id == task_id,
        ProjectChatMessage.sender_type == "agent",
        ProjectChatMessage.status == "completed",
        ProjectChatMessage.metadata_json["runtime_turn_id"].as_string() == turn_id,
        loop_datetime_is_unset(ProjectChatMessage.deleted_at),
    )


def _lock_content_execution(
    db: Session, execution_id: int | str
) -> LoopItemExecution | None:
    return (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.id == execution_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )


def _completed_content_sequence(payload: dict) -> int:
    raw_sequence = payload.get("eventSeq", payload.get("event_seq"))
    if isinstance(raw_sequence, bool):
        return 0
    try:
        return int(raw_sequence)
    except (TypeError, ValueError):
        return 0


def _accept_completed_content(
    execution: LoopItemExecution | None,
    row: ProjectChatMessage,
    sequence: int,
    owner_user_id: int | None,
) -> bool:
    return bool(
        execution is not None
        and execution.status == "completed"
        and str((row.metadata_json or {}).get("execution_id")) == str(execution.id)
        and sequence > execution.last_event_seq
        and execution.runtime_task_id == row.runtime_task_id
        and execution.runtime_device_id == row.runtime_device_id
        and execution.cloud_project_id == row.project_id
        and execution.loop_item_id == row.task_id
        and (owner_user_id is None or execution.executor_owner_user_id == owner_user_id)
    )


def _match_turn(
    row: ProjectChatMessage,
    snapshot: RuntimeExecutionSnapshot,
    *,
    single_execution: bool,
) -> RuntimeExecutionTurnSnapshot | None:
    metadata = row.metadata_json or {}
    binding = metadata.get("runtime_turn_id")
    for identity in (binding, row.message_id, row.trigger_message_id):
        if not identity:
            continue
        matches = [
            turn
            for turn in snapshot.turns
            if (
                turn.id == identity
                if identity == binding
                else identity in turn.user_message_ids
            )
        ]
        if matches:
            return matches[0] if len(matches) == 1 else None
        if identity == binding:
            return None
    # Older clients did not attach trigger IDs. Only a complete, unambiguous
    # single execution history can establish that legacy association.
    if (
        single_execution
        and snapshot.complete_history
        and snapshot.running is False
        and len(snapshot.turns) == 1
    ):
        turn = snapshot.turns[0]
        completed_at = _completion_time(turn.completed_at)
        created_at = (
            row.created_at.replace(tzinfo=database_datetime_timezone())
            .astimezone(UTC)
            .replace(tzinfo=None)
        )
        if completed_at is not None and completed_at >= created_at:
            return turn
    return None


def _completion_time(value: str | int | float | None) -> datetime | None:
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return datetime.fromtimestamp(value / 1000, UTC).replace(tzinfo=None)
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return (
                parsed.astimezone(UTC).replace(tzinfo=None) if parsed.tzinfo else parsed
            )
    except (ValueError, OverflowError, OSError):
        return None
    return None


def reconcile_execution_snapshot(
    db: Session, *, user_id: int, snapshot: RuntimeExecutionSnapshot
) -> list[dict]:
    """Persist only outcomes matched to one run on a device owned by the caller."""
    device = resolve_owned_device_alias(
        db, user_id=user_id, device_id=snapshot.device_id
    )
    if device is None:
        raise HTTPException(403, "Runtime device is not owned by the current user")
    rows = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id.in_(device_identity_ids(device)),
            ProjectChatMessage.runtime_task_id == snapshot.task_id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .order_by(ProjectChatMessage.id)
        .all()
    )
    rows = [
        r for r in rows if (r.metadata_json or {}).get("kind") != "task_ai_subagent"
    ]
    candidates = []
    for row in rows:
        if row.status not in {"pending", "streaming"}:
            continue
        turn = _match_turn(row, snapshot, single_execution=len(rows) == 1)
        if turn is None or turn.status not in TERMINAL_STATUSES:
            continue
        project_chat_service._require_scope(
            db,
            user_id=user_id,
            project_id=row.project_id,
            task_id=row.task_id or None,
            required_role=BaseRole.Developer,
        )
        candidates.append((row, turn))
    changed: list[ProjectChatMessage] = []
    for row, turn in candidates:
        if _persist_outcome(db, row, turn, user_id, device_identity_ids(device)):
            changed.append(row)
    project_chat_service._commit(db)
    return [
        project_chat_service.to_view(row, db=db).model_dump(mode="json", by_alias=True)
        for row in changed
    ]


def _persist_outcome(
    db: Session,
    row: ProjectChatMessage,
    turn: RuntimeExecutionTurnSnapshot,
    user_id: int,
    device_ids: list[str],
) -> bool:
    from app.services.loop_item_executions.service import loop_item_execution_service

    status = TERMINAL_STATUSES[turn.status]
    metadata = dict(row.metadata_json or {})
    execution_id = metadata.get("execution_id")
    # Match the event projection's lock order: execution root, then activity.
    # Include terminal roots so a stale report cannot contradict their outcome.
    execution = (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.id == execution_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
        if execution_id
        else loop_item_execution_service.execution_for_runtime(
            db,
            runtime_device_id=row.runtime_device_id,
            runtime_task_id=row.runtime_task_id,
            owner_user_id=user_id,
        )
    )
    if execution_id and execution is None:
        return False
    if execution is not None and (
        str(execution_id or "") != str(execution.id)
        or execution.executor_owner_user_id != user_id
        or execution.runtime_task_id != row.runtime_task_id
        or execution.runtime_device_id not in device_ids
        or execution.cloud_project_id != row.project_id
        or execution.loop_item_id != row.task_id
    ):
        return False
    row = (
        db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.id == row.id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    if row.status not in {"pending", "streaming"}:
        return False
    metadata = dict(row.metadata_json or {})
    if execution is not None:
        # Managed runs have their own aggregate root. Never update a different
        # attempt merely because it reused the same Runtime conversation.
        if (
            execution.status in TERMINAL_STATUSES.values()
            and execution.status != status
        ):
            return False
        # Reconciliation commits the elected outcome. Bind its verified turn
        # in that same commit so a final event can already address its text.
        row.metadata_json = {
            **metadata,
            "runtime_turn_id": turn.id,
            "runtime_completed_at": turn.completed_at,
        }
        db.flush()
        execution = loop_item_execution_service.reconcile_runtime_snapshot(
            db, execution_id=execution.id, runtime_status=status, running=False
        )
        if execution is None or execution.status != status:
            return False
        db.refresh(row)
        metadata = dict(row.metadata_json or {})
    row.status = status
    row.metadata_json = {
        **metadata,
        "run_status": status,
        "runtime_turn_id": turn.id,
        "runtime_completed_at": turn.completed_at,
    }
    # Only the current run owns the task's AI summary. Finishing an older turn
    # must not overwrite a newer continuation or advance business workflow.
    task = (
        db.query(LoopItem)
        .filter(LoopItem.id == row.task_id, LoopItem.cloud_project_id == row.project_id)
        .with_for_update()
        .one_or_none()
    )
    ai_state = (task.metadata_json or {}).get("ai_state", {}) if task else {}
    if (
        ai_state.get("project_chat_message_id") == row.message_id
        and ai_state.get("run_id") == metadata.get("run_id")
        and ai_state.get("status") in {"running", "pending", "queued"}
    ):
        project_chat_service._set_task_ai_state(
            db, row=row, trigger=None, agent=None, status_value=status
        )
    return True
