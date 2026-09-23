# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Render a task notification as a DingTalk markdown card with buttons.

The card is built from DingTalk's built-in markdown template rather than the AI
one: an AI card carries the assistant's own feedback row (thumbs up and down),
which a task notification does not want, and it only surfaces once it reaches a
terminal ``flowStatus``. The markdown template lands as soon as it is delivered
and paints the headline in a header slot of its own, which is the only way it
draws text larger than the body — a markdown heading is no bigger, and the
template drops markdown's ``---`` and ``***`` instead of drawing a rule.
"""

import json
from collections.abc import Sequence

from app.services.channels.dingtalk.markdown import escape_markdown
from app.services.notification_copy import NotificationLink, PushNotification

TITLE_KEY = "title"
MARKDOWN_KEY = "markdown"
TIPS_KEY = "tips"
BUTTONS_KEY = "msgButtons"

# One colour per destination: the first button is the primary way in.
BUTTON_COLORS = ("blue", "gray")


def card_param_map(
    *,
    push: PushNotification,
    links: Sequence[NotificationLink] = (),
) -> dict[str, str]:
    """The ``cardParamMap`` of one finished notification card."""

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
