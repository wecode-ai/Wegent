"""Persistent Wework notifications for a board task's own run lifecycle."""

import logging

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.services.notification_copy import execution_message
from app.services.notification_target import board_notification_target
from app.services.wework_notifications import create_notification

logger = logging.getLogger(__name__)

RUNNING_STATUSES = {"queued", "claimed", "running"}
INTERVENTION_STATUSES = {"pending_approval", "waiting_runtime"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
ACTIONABLE_STATUSES = RUNNING_STATUSES | INTERVENTION_STATUSES | TERMINAL_STATUSES


def notify_execution_lifecycle(
    db: Session,
    *,
    execution: LoopItemExecution,
    status: str,
    content: str = "",
) -> None:
    """Create the lifecycle inbox entry for one execution state transition.

    The task's assignee is the recipient; an unassigned task notifies its
    creator instead. Detached executions without a resolvable task or
    recipient are ignored, so delivery never blocks the execution pipeline.
    """

    try:
        _notify_execution_lifecycle(
            db, execution=execution, status=status, content=content
        )
    except Exception:
        # Lifecycle alerts are supplementary: a notification failure must never
        # roll back the execution transition that triggered it.
        logger.exception(
            "Execution lifecycle notification failed: execution=%s status=%s",
            getattr(execution, "id", None),
            status,
        )


def _notify_execution_lifecycle(
    db: Session,
    *,
    execution: LoopItemExecution,
    status: str,
    content: str,
) -> None:
    if status not in ACTIONABLE_STATUSES:
        return
    item = db.get(LoopItem, execution.loop_item_id)
    if item is None:
        return
    recipient_id = item.assignee_user_id or item.created_by_user_id
    if not recipient_id:
        return
    project = db.get(CloudProject, int(item.cloud_project_id or 0))
    if project is None:
        return

    message = execution_message(
        target=board_notification_target(db, project, item),
        status=status,
        detail=content,
        execution_id=str(execution.id) if execution.id else None,
    )
    create_notification(
        db,
        user_id=int(recipient_id),
        actor_user_id=int(execution.executor_owner_user_id or recipient_id),
        kind=message.kind,
        title=message.title,
        body=message.body,
        project_id=str(project.id),
        item_id=item.id,
        payload=message.payload,
    )
