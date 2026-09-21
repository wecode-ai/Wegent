"""One place for the copy that every Wework notification and IM push shares.

The inbox renders ``title`` as the row headline and ``body`` underneath it. An
IM push renders the same pair through :func:`notification_message`, and
DingTalk markdown bolds the headline. Building the two strings together is what
keeps the inbox, the DingTalk push and the runtime reply notice in one style as
new notification kinds appear.
"""

from dataclasses import dataclass

BOARD_LABEL = "看板"
RUNTIME_REPLY_HINT = "引用本通知回复，即可继续该任务。"


@dataclass(frozen=True)
class NotificationCopy:
    """A headline plus the self-contained detail shown underneath it."""

    title: str
    body: str


def notification_message(title: str, body: str) -> str:
    """Plain-text IM form: the headline, a blank line, then the detail."""

    if not title:
        return body
    return f"{title}\n\n{body}" if body else title


def detail_with_board(detail: str, project_name: str | None) -> str:
    """Put the detail first and close with the board it belongs to."""

    footer = f"{BOARD_LABEL}：{project_name}" if project_name else ""
    if not footer:
        return detail
    return f"{detail}\n\n{footer}" if detail else footer


def mention_copy(
    *,
    actor_name: str,
    item_title: str | None,
    project_name: str | None,
    preview: str,
) -> NotificationCopy:
    """A member was mentioned in a comment on a board item."""

    where = f"在「{item_title}」" if item_title else "在评论中"
    return NotificationCopy(
        title=f"{actor_name} {where}提到了你",
        body=detail_with_board(preview, project_name),
    )


def assignment_copy(
    *,
    assigner_name: str,
    item_title: str,
    project_name: str | None,
) -> NotificationCopy:
    """A board item was assigned to the recipient."""

    return NotificationCopy(
        title=f"{assigner_name} 把「{item_title}」分配给了你",
        body=detail_with_board("", project_name),
    )


def runtime_update_copy(
    *,
    task_title: str,
    status: str,
    content: str,
) -> NotificationCopy:
    """A Wework runtime task moved on and needs the owner to notice."""

    if status == "waiting_user_input":
        return NotificationCopy(
            title=f"任务「{task_title}」需要你确认",
            body=content or "任务已暂停，等待你的输入或确认后继续。",
        )
    if status in {"failed", "FAILED"}:
        return NotificationCopy(
            title=f"任务「{task_title}」执行失败",
            body=content or "任务执行失败，请打开 Wework 查看原因。",
        )
    if status in {"cancelled", "CANCELLED"}:
        return NotificationCopy(
            title=f"任务「{task_title}」已取消",
            body=content or "任务已取消。",
        )
    return NotificationCopy(
        title=f"任务「{task_title}」有新的 AI 回复",
        body=content or "任务有新的更新，请打开 Wework 查看完整对话。",
    )
