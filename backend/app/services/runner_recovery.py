"""Explicit recovery of rejected runner assignments, without moving live work."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.loop_item_execution import LoopItemExecution


def runner_recovery_available(
    db: Session, issue_id: str, *, exclude_execution_id: int | None = None
) -> bool:
    query = db.query(LoopItemExecution.id).filter(
        LoopItemExecution.loop_item_id == issue_id,
        LoopItemExecution.status.in_(
            ["queued", "pending_approval", "claimed", "running", "cancel_requested"]
        ),
        ~LoopItemExecution.assignment_pending,
    )
    if exclude_execution_id is not None:
        query = query.filter(LoopItemExecution.id != exclude_execution_id)
    return query.first() is None


def original_session(execution: Any) -> bool:
    """Continuations retain their own device even after another run recovers."""
    return bool(
        getattr(execution, "runtime_device_id", "")
        and getattr(execution, "runtime_request", {}).get("newSession") is False
    )


def permits_runner_recovery(db: Session, execution: Any, bound_id: str | None) -> bool:
    from app.services.runner_routing import automatic_execution

    snapshot = execution.runtime_selection.get("runner_routing") or {}
    return bool(
        bound_id
        and snapshot.get("recovery_from_environment_id") == bound_id
        and not automatic_execution(execution)
        and runner_recovery_available(
            db,
            execution.loop_item_id,
            exclude_execution_id=getattr(execution, "id", None),
        )
    )
