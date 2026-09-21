"""Persistent Wework notifications for a board task's own run lifecycle."""

import logging

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.services.notification_copy import NotificationCopy, detail_with_board
from app.services.wework_notifications import create_notification

logger = logging.getLogger(__name__)

EXECUTION_KIND = "execution"
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

    copy = _notification_copy(
        item,
        status=status,
        content=content,
        project_name=project.name,
    )
    create_notification(
        db,
        user_id=int(recipient_id),
        actor_user_id=int(execution.executor_owner_user_id or recipient_id),
        kind=EXECUTION_KIND,
        title=copy.title,
        body=copy.body,
        project_id=str(project.id),
        item_id=item.id,
        payload={
            "projectId": str(project.id),
            "projectName": project.name,
            "itemId": item.id,
            "itemTitle": item.title,
            "executionId": execution.id,
            "status": status,
        },
    )


def _notification_copy(
    item: LoopItem,
    *,
    status: str,
    content: str,
    project_name: str | None = None,
) -> NotificationCopy:
    item_title = item.title or "任务"
    if status == "pending_approval":
        return _board_copy(
            f"「{item_title}」等待你审批",
            "机器人任务已进入队列，需要你确认后才会开始执行。",
            project_name,
        )
    if status == "waiting_runtime":
        return _board_copy(
            f"「{item_title}」需要选择运行设备",
            "任务已就绪，选择设备和模型后即可开始执行。",
            project_name,
        )
    if status in {"failed", "cancelled"}:
        body = content.strip() or (
            "任务执行失败。" if status == "failed" else "任务已取消。"
        )
        return _board_copy(f"「{item_title}」执行未成功", body, project_name)
    if status == "completed":
        body = content.strip() or "任务已完成，请打开任务查看结果。"
        return _board_copy(f"「{item_title}」已完成", body, project_name)
    return _board_copy(
        f"「{item_title}」已开始执行",
        f"{item_title} 已进入执行，完成后会再次通知你。",
        project_name,
    )


def _board_copy(title: str, detail: str, project_name: str | None) -> NotificationCopy:
    """Attach the board to an execution notice so it reads like every other one."""

    return NotificationCopy(title=title, body=detail_with_board(detail, project_name))
