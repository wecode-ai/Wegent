"""Explicit recovery of rejected runner assignments, without moving live work."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.services.device.identity import resolve_owned_device_alias


def runner_recovery_available(
    db: Session,
    issue_id: str,
    *,
    exclude_execution_id: int | None = None,
    locking: bool = False,
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
    if locking:
        query = query.with_for_update()
    return query.first() is None


def lock_recovery_source(db: Session, issue_id: str, expected: str) -> bool:
    from app.services.runner_routing import issue_binding

    db.flush()
    issue = (
        db.query(LoopItem)
        .filter_by(id=issue_id)
        .with_for_update()
        .populate_existing()
        .first()
    )
    return bool(
        issue
        and issue_binding(db, issue_id) == expected
        and runner_recovery_available(db, issue_id, locking=True)
    )


def original_session(execution: Any) -> bool:
    """Continuations retain their own device even after another run recovers."""
    return bool(
        getattr(execution, "runtime_device_id", "")
        and getattr(execution, "runtime_request", {}).get("newSession") is False
    )


def session_matches(db: Session, execution: Any, device_id: int) -> bool:
    if not original_session(execution):
        return True
    source = resolve_owned_device_alias(
        db,
        user_id=execution.executor_owner_user_id,
        device_id=execution.runtime_device_id,
    )
    return source is not None and source.id == device_id


def permits_runner_recovery(
    db: Session, execution: Any, bound_id: str | None, *, locking: bool = False
) -> bool:
    from app.services.runner_routing import automatic_execution

    snapshot = execution.runtime_selection.get("runner_routing") or {}
    context = execution.runtime_origin_context or {}
    key = context.get("assignment_key")
    # Manual group dispatches also have internal run IDs.
    manual_group = (
        context.get("dispatch_kind") == "collaboration_group"
        and bool(key)
        and getattr(execution, "automation_run_id", None)
        == f"collaboration-group:{key}"
        and context.get("run_id") == f"collaboration-group:{key}"
    )
    return bool(
        bound_id
        and snapshot.get("recovery_from_environment_id") == bound_id
        and (not automatic_execution(execution) or manual_group)
        and runner_recovery_available(
            db,
            execution.loop_item_id,
            exclude_execution_id=getattr(execution, "id", None),
            locking=locking,
        )
    )
