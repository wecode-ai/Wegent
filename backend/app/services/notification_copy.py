"""The copy and the payload that every Wework notification shares.

The inbox renders ``title`` above ``body``; an IM push renders the same two
strings through :func:`notification_message`. Both channels read the payload
too, so the fields a recipient actually needs — which board, which item, what
state it is in, and which comment they were mentioned in — are built here
instead of being spelled out again at every call site.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

BOARD_LABEL = "看板"
RUNTIME_REPLY_HINT = "引用本通知回复，即可继续该任务。"
COMMENT_PREVIEW_MAX_CHARS = 200
WEWORK_LINK_LABEL = "在 Wework 打开"
WEB_LINK_LABEL = "在浏览器打开"


def comment_preview(content: str, limit: int = COMMENT_PREVIEW_MAX_CHARS) -> str:
    """Collapse a comment into the one-line excerpt a notification shows."""

    collapsed = " ".join(content.split())
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[: limit - 1]}…"


def fact_block(
    *,
    facts: Sequence[tuple[str, str | None]],
    detail: str = "",
    detail_label: str = "",
) -> str:
    """Render the ``标签：值`` block an IM push closes with.

    DingTalk collapses a single newline inside a markdown message, so every line
    is separated by a blank one to keep the facts readable on a phone.
    """

    lines = [f"{label}：{value}" for label, value in facts if value]
    if detail and detail_label:
        lines.append(f"{detail_label}：{detail}")
    return "\n\n".join(lines)


@dataclass(frozen=True)
class NotificationLink:
    """One destination a push offers the recipient."""

    label: str
    url: str


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
    assignee_name: str | None = None

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
            ("assigneeName", self.assignee_name),
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


@dataclass(frozen=True)
class PushNotification:
    """One notification as a push shows it.

    A push has no summary line, so the facts the inbox row only implies travel
    as labelled lines; a card renders the same facts under a header of its own.
    """

    headline: str
    card_headline: str
    facts: tuple[tuple[str, str], ...] = ()
    detail_label: str = ""
    detail: str = ""

    def plain_text(self) -> str:
        """The body a plain push carries.

        DingTalk collapses a single newline inside a markdown message, so the
        lines are separated by blank ones to stay readable on a phone.
        """

        lines = [f"{label}：{value}" for label, value in self.facts]
        if self.detail:
            lines.append(
                f"{self.detail_label}：{self.detail}"
                if self.detail_label
                else self.detail
            )
        return "\n\n".join(lines)


def push_copy(
    *,
    kind: str,
    title: str,
    body: str = "",
    payload: dict[str, Any] | None = None,
) -> PushNotification:
    """The push form of a stored notification.

    The inbox renders ``title`` above ``body`` next to its own summary line, so
    the stored copy stays short. A push has no summary line, so it restates the
    facts the recipient needs, and a channel whose cards have a header of their
    own gets a headline that stays readable there.
    """

    data = payload or {}
    facts = _push_facts(
        data,
        run_status=(
            _EXECUTION_TAILS.get(str(data.get("status")))
            if kind in {"execution", "runtime"}
            else None
        ),
    )
    headline = _push_headline(kind, title, data)
    detail = body.strip()
    if not facts:
        # A notification without structured context keeps its own body, and has
        # nothing a card header could be shortened against either.
        return PushNotification(
            headline=headline,
            card_headline=headline,
            detail=detail,
        )
    return PushNotification(
        headline=headline,
        card_headline=_card_headline(kind, title, data),
        facts=tuple((label, str(value)) for label, value in facts),
        detail_label=_detail_label(kind, data),
        detail=detail,
    )


def _push_headline(kind: str, title: str, payload: dict[str, Any]) -> str:
    if kind == "execution":
        tail = _EXECUTION_TAILS.get(str(payload.get("status")), "有新的进展")
        return f"你的任务{tail}"
    if kind == "mention":
        actor = payload.get("actorName")
        return f"{actor} 在评论中提到了你" if actor else title
    return title


# A card leads with the action; the item it is about is named in the body
# already, so repeating it in a header only wraps it onto a second line.
_CARD_STATUS_EMOJI = {
    "completed": "✅",
    "failed": "⚠️",
    "FAILED": "⚠️",
    "cancelled": "🚫",
    "CANCELLED": "🚫",
    "queued": "🚀",
    "claimed": "🚀",
    "running": "🚀",
    "pending_approval": "⏳",
    "waiting_user_input": "💬",
    "waiting_runtime": "🖥️",
}


def _card_headline(kind: str, title: str, payload: dict[str, Any]) -> str:
    if kind == "execution":
        status = str(payload.get("status"))
        tail = _EXECUTION_TAILS.get(status, "有新的进展")
        return f"{_CARD_STATUS_EMOJI.get(status, 'ℹ️')} 你的任务{tail}"
    if kind == "mention":
        actor = payload.get("actorName")
        return f"🔔 {actor} 在评论中提到了你" if actor else f"🔔 {title}"
    if kind == "assignment":
        actor = payload.get("actorName")
        return f"📌 {actor} 把任务分配给了你" if actor else f"📌 {title}"
    return title


def _push_facts(
    payload: dict[str, Any], *, run_status: str | None = None
) -> list[tuple[str, str | None]]:
    """The ``标签：值`` facts a push shows.

    A run notice reports the run's own state; a comment or assignment notice has
    no run, so it reports the board column the item sits in.
    """

    facts = [
        ("任务标题", payload.get("itemTitle")),
        ("任务编号", payload.get("itemKey") or payload.get("itemId")),
        ("任务状态", run_status or payload.get("itemStatus")),
        ("当前负责人", payload.get("assigneeName")),
        (BOARD_LABEL, payload.get("projectName")),
    ]
    return [(label, value) for label, value in facts if value]


_DETAIL_LABELS = {
    "completed": "任务结果",
    "failed": "失败原因",
    "FAILED": "失败原因",
    "cancelled": "取消原因",
    "CANCELLED": "取消原因",
}


def _detail_label(kind: str, payload: dict[str, Any]) -> str:
    if kind == "mention":
        return "评论内容"
    label = _DETAIL_LABELS.get(str(payload.get("status")))
    if label:
        return label
    return "最新回复" if kind == "runtime" else "说明"


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

    where = f"「{target.item_title}」" if target.item_title else "任务"
    return NotificationMessage(
        kind="assignment",
        title=f"{assigner_name} 把{where}分配给了你",
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
        title=f"你的任务{prefix}",
        body=fact_block(
            facts=[("任务标题", task_title), ("任务状态", prefix)],
            detail=body,
            detail_label=_detail_label("runtime", {"status": status}),
        ),
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
