# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Serialize notifications for the built-in and custom DingTalk card templates."""

import json
from collections.abc import Sequence
from urllib.parse import unquote, urlencode, urlsplit

from app.core.config import settings
from app.schemas.dingtalk_card import BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID
from app.schemas.wework_navigation import validate_wework_url
from app.services.channels.dingtalk.markdown import escape_markdown
from app.services.notification_copy import NotificationLink, PushNotification

TITLE_KEY = "title"
MARKDOWN_KEY = "markdown"
TIPS_KEY = "tips"
BUTTONS_KEY = "msgButtons"

# One colour per destination: the first button is the primary way in.
BUTTON_COLORS = ("blue", "gray")
MAX_CARD_DETAIL_CHARS = 240

KIND_PRESENTATION = {
    "mention": ("评论提及", "blue"),
    "assignment": ("任务分配", "blue"),
}
EXECUTION_PRESENTATION = {
    "queued": ("已入队", "blue"),
    "claimed": ("准备执行", "blue"),
    "running": ("执行中", "blue"),
    "pending_approval": ("待审批", "orange"),
    "waiting_user_input": ("待确认", "orange"),
    "waiting_runtime": ("待选设备", "orange"),
    "completed": ("已完成", "green"),
    "failed": ("执行失败", "red"),
    "cancelled": ("已取消", "gray"),
}


def card_param_map(
    *,
    push: PushNotification,
    links: Sequence[NotificationLink] = (),
    card_template_id: str = BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID,
) -> dict[str, str]:
    """Use the variable contract declared by the selected DingTalk template."""

    if card_template_id == BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID:
        return _builtin_card_param_map(push=push, links=links)
    return _custom_card_param_map(push=push, links=links)


def _builtin_card_param_map(
    *,
    push: PushNotification,
    links: Sequence[NotificationLink],
) -> dict[str, str]:
    """The DingTalk-provided markdown template keeps its original contract."""

    card_data = {
        # The header slot is plain text, so the headline goes in unescaped: an
        # escaped name would show its backslashes there.
        TITLE_KEY: push.card_headline,
        MARKDOWN_KEY: _body(push),
        TIPS_KEY: "",
    }
    buttons = _buttons(links)
    if buttons:
        card_data["sys_full_json_obj"] = json.dumps(
            {BUTTONS_KEY: buttons}, ensure_ascii=False
        )
    return card_data


def _custom_card_param_map(
    *,
    push: PushNotification,
    links: Sequence[NotificationLink],
) -> dict[str, str]:
    """The Wegent template renders the action, item, context, and detail apart."""

    kind_label, tone = _presentation(push)
    primary = next(
        (link for link in links if link.url.startswith(("https://", "http://"))),
        None,
    )
    secondary = next((link for link in links if link.url.startswith("wework://")), None)
    secondary_url = _wework_handoff_url(secondary.url) if secondary else ""
    detail = _card_detail(push.detail)
    return {
        "kindLabel": kind_label,
        "tone": tone,
        "headline": push.headline,
        "itemTitle": _payload_text(push, "itemTitle"),
        "itemKey": _payload_text(push, "itemKey"),
        "metaLine": _meta_line(push),
        "detailLabel": push.detail_label,
        "detail": detail,
        "showDetail": "true" if detail else "false",
        "primaryLabel": primary.label if primary else "",
        "primaryUrl": primary.url if primary else "",
        "secondaryLabel": secondary.label if secondary_url else "",
        "secondaryUrl": secondary_url,
    }


def _wework_handoff_url(destination: str) -> str:
    """Expose only a validated board destination through Wegent's web page."""

    try:
        url = urlsplit(validate_wework_url(destination))
        if url.netloc != "boards":
            return ""
        parts = [unquote(part, errors="strict") for part in url.path.split("/")[1:]]
    except ValueError:
        return ""
    if not parts or not parts[0]:
        return ""
    params = {"projectId": parts[0]}
    if len(parts) >= 3:
        params["itemId"] = parts[2]
    if len(parts) == 5:
        params["commentId"] = parts[4]
    return f"{settings.FRONTEND_URL.rstrip('/')}/open-wework?{urlencode(params)}"


def _presentation(push: PushNotification) -> tuple[str, str]:
    if push.kind == "execution":
        status = _payload_text(push, "status").lower()
        return EXECUTION_PRESENTATION.get(status, ("任务进展", "blue"))
    return KIND_PRESENTATION.get(push.kind, ("任务通知", "gray"))


def _payload_text(push: PushNotification, key: str) -> str:
    return str(push.payload.get(key) or "")


def _card_detail(detail: str) -> str:
    if len(detail) <= MAX_CARD_DETAIL_CHARS:
        return detail
    return f"{detail[: MAX_CARD_DETAIL_CHARS - 1]}…"


def _meta_line(push: PushNotification) -> str:
    parts = [
        _payload_text(push, "projectName"),
        _payload_text(push, "itemStatus"),
    ]
    assignee = _payload_text(push, "assigneeName")
    if assignee:
        parts.append(f"负责人：{assignee}")
    return " · ".join(part for part in parts if part)


def _body(push: PushNotification) -> str:
    """The card body.

    Labels are bolded because a DingTalk card renders every line the same way,
    which otherwise leaves a key indistinguishable from its value. Only the
    values are escaped: the labels and the detail label are our own copy, while
    a value — a comment, a failure reason — is whatever a member typed.
    """

    lines = [f"**{label}**：{escape_markdown(value)}" for label, value in push.facts]
    if push.detail:
        if lines:
            # Keep the detail — a comment, a result — apart from the facts it
            # is not one of.
            lines.append("")
        if push.detail_label:
            lines.append(f"**{push.detail_label}**")
        lines.extend(f"> {line}" for line in escape_markdown(push.detail).splitlines())
    return "\n".join(lines)


def _buttons(links: Sequence[NotificationLink]) -> list[dict[str, str]]:
    return [
        {
            "text": link.label,
            "url": link.url,
            "color": BUTTON_COLORS[min(index, len(BUTTON_COLORS) - 1)],
        }
        for index, link in enumerate(links)
    ]
