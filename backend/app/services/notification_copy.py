"""The copy and the payload that every Wework notification shares.

The inbox renders ``title`` above ``body``; an IM push renders the same two
strings through :func:`notification_message`. Both channels read the payload
too, so the fields a recipient actually needs — which board, which item, what
state it is in, and which comment they were mentioned in — are built here
instead of being spelled out again at every call site.
"""

from dataclasses import dataclass, field
from typing import Any

BOARD_LABEL = "看板"
RUNTIME_REPLY_HINT = "引用本通知回复，即可继续该任务。"
COMMENT_PREVIEW_MAX_CHARS = 200


def comment_preview(content: str, limit: int = COMMENT_PREVIEW_MAX_CHARS) -> str:
    """Collapse a comment into the one-line excerpt a notification shows."""

    collapsed = " ".join(content.split())
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[: limit - 1]}…"


def board_footer(project_name: str | None) -> str:
    """The board line a push closes with; the inbox shows it in its summary."""

    return f"{BOARD_LABEL}：{project_name}" if project_name else ""


@dataclass(frozen=True)
class NotificationTarget:
    """The board entry a notification points at."""

    project_id: str
    project_name: str
    item_id: str | None = None
    item_key: str | None = None
    item_title: str | None = None
    item_status: str | None = None
    item_priority: str | None = None
    item_due_at: str | None = None

    def payload(self) -> dict[str, Any]:
        """The board fields every board notification carries."""

        payload: dict[str, Any] = {
            "projectId": self.project_id,
            "projectName": self.project_name,
        }
        for key, value in (
            ("itemId", self.item_id),
            ("itemKey", self.item_key),
            ("itemTitle", self.item_title),
            ("itemStatus", self.item_status),
            ("itemPriority", self.item_priority),
            ("itemDueAt", self.item_due_at),
        ):
            if value:
                payload[key] = value
        return payload


@dataclass(frozen=True)
class NotificationMessage:
    """One notification: its kind, its copy, its payload and its landing spot."""

    kind: str
    title: str
    body: str
    payload: dict[str, Any] = field(default_factory=dict)
    # Set when the link should open one comment instead of the top of the item.
    comment_id: str | None = None


def notification_message(title: str, body: str) -> str:
    """Plain-text IM form: the headline, a blank line, then the detail."""

    if not title:
        return body
    return f"{title}\n\n{body}" if body else title


def mention_message(
    *,
    actor_name: str,
    preview: str,
    comment_id: str,
    target: NotificationTarget,
    reply_preview: str | None = None,
) -> NotificationMessage:
    """A member was mentioned in a comment on a board item."""

    where = f"在「{target.item_title}」" if target.item_title else "在评论中"
    payload: dict[str, Any] = {
        **target.payload(),
        "actorName": actor_name,
        "commentId": comment_id,
        "commentPreview": preview,
    }
    if reply_preview:
        payload["replyPreview"] = reply_preview
    return NotificationMessage(
        kind="mention",
        title=f"{actor_name} {where}提到了你",
        body=preview,
        payload=payload,
        comment_id=comment_id,
    )


def assignment_message(
    *,
    assigner_name: str,
    target: NotificationTarget,
) -> NotificationMessage:
    """A board item was assigned to the recipient."""

    return NotificationMessage(
        kind="assignment",
        title=f"{assigner_name} 把「{target.item_title}」分配给了你",
        body="",
        payload={**target.payload(), "actorName": assigner_name},
    )


def execution_message(
    *,
    target: NotificationTarget,
    status: str,
    detail: str = "",
    execution_id: str | None = None,
) -> NotificationMessage:
    """A board item's own robot run moved on and needs the assignee to notice."""

    item_title = target.item_title or "任务"
    prefix, body = _execution_copy(item_title, status=status, detail=detail)
    payload: dict[str, Any] = {
        **target.payload(),
        "status": status,
    }
    if execution_id:
        payload["executionId"] = execution_id
    return NotificationMessage(
        kind="execution",
        title=f"「{item_title}」{prefix}",
        body=body,
        payload=payload,
    )


def runtime_message(
    *,
    task_title: str,
    status: str,
    content: str,
) -> NotificationMessage:
    """A Wework runtime task moved on; only IM can act on it, by replying."""

    prefix, body = _execution_copy(task_title, status=status, detail=content)
    return NotificationMessage(
        kind="runtime",
        title=f"任务「{task_title}」{prefix}",
        body=body,
    )


def _execution_copy(task_title: str, *, status: str, detail: str) -> tuple[str, str]:
    """The headline tail and the detail shared by board runs and runtime tasks."""

    detail = detail.strip()
    tail = _EXECUTION_TAILS.get(status)
    if tail is None:
        return (
            "有新的 AI 回复",
            detail or "任务有新的更新，请打开 Wework 查看完整对话。",
        )
    return tail, detail or _EXECUTION_DETAILS[status].format(title=task_title)


# The headline tail reads the same whether the run belongs to a board item or a
# local runtime task; only the noun in front of it differs.
_EXECUTION_TAILS = {
    "pending_approval": "等待你审批",
    "waiting_user_input": "需要你确认",
    "waiting_runtime": "需要选择运行设备",
    "failed": "执行未成功",
    "FAILED": "执行未成功",
    "cancelled": "已取消",
    "CANCELLED": "已取消",
    "completed": "已完成",
    "queued": "已开始执行",
    "claimed": "已开始执行",
    "running": "已开始执行",
}

_STARTED_DETAIL = "{title} 已进入执行，完成后会再次通知你。"

_EXECUTION_DETAILS = {
    "pending_approval": "机器人任务已进入队列，需要你确认后才会开始执行。",
    "waiting_user_input": "任务已暂停，等待你的输入或确认后继续。",
    "waiting_runtime": "任务已就绪，选择设备和模型后即可开始执行。",
    "failed": "任务执行失败，请打开 Wework 查看原因。",
    "FAILED": "任务执行失败，请打开 Wework 查看原因。",
    "cancelled": "任务已取消。",
    "CANCELLED": "任务已取消。",
    "completed": "任务已完成，请打开任务查看结果。",
    "queued": _STARTED_DETAIL,
    "claimed": _STARTED_DETAIL,
    "running": _STARTED_DETAIL,
}
