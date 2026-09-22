# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Render a task notification as a finished DingTalk AI card.

A proactively pushed AI card only surfaces in the chat once it reaches a
terminal ``flowStatus``: nobody replies to it, so there is no later frame that
could move it on. The body therefore goes out with the card itself, and the
built-in markdown card renders exactly the fields its ``sys_full_json_obj.order``
lists — a field left out of that order is hidden, body included.
"""

import json
from collections.abc import Sequence

from app.services.channels.dingtalk.markdown import escape_markdown
from app.services.notification_copy import NotificationLink, PushNotification

TITLE_KEY = "msgTitle"
CONTENT_KEY = "msgContent"
STATIC_CONTENT_KEY = "staticMsgContent"
BUTTONS_KEY = "msgButtons"
CARD_ORDER = [TITLE_KEY, CONTENT_KEY, STATIC_CONTENT_KEY, BUTTONS_KEY]

# The status DingTalk defines for a card whose work is done.
FINISHED_FLOW_STATUS = "3"

# One colour per destination: the first button is the primary way in.
BUTTON_COLORS = ("blue", "gray")


def card_param_map(
    *,
    push: PushNotification,
    links: Sequence[NotificationLink] = (),
) -> dict[str, str]:
    """The ``cardParamMap`` of one finished notification card."""

    body = _body(push)
    card_data = {
        TITLE_KEY: push.card_headline,
        # Both content fields carry the finished body: the streaming field is
        # what a phone renders while a card is still being written, and the
        # static one is what it keeps once the card stops.
        CONTENT_KEY: body,
        STATIC_CONTENT_KEY: body,
        "flowStatus": FINISHED_FLOW_STATUS,
    }
    full_json: dict[str, object] = {"order": CARD_ORDER}
    buttons = _buttons(links)
    if buttons:
        full_json[BUTTONS_KEY] = buttons
    card_data["sys_full_json_obj"] = json.dumps(full_json, ensure_ascii=False)
    return card_data


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
