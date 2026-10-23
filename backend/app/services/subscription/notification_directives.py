# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Parse per-message controls for subscription group notifications."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

GROUP_NOTIFICATION_CONTROL_INSTRUCTION = (
    "群通知控制（仅影响已绑定的群聊，不影响私聊）："
    "如果本次不需要发送群聊通知，请在回答最后单独一行输出“[静默]”；"
    "如果需要在群聊中 @ 指定成员，请在最后单独一行输出"
    "“[@列表:staffId1,staffId2]”或“[mention:staffId1,staffId2]”，"
    "将 staffId 替换为实际工号；方括号也可以写成【】。"
    "这些控制标记只用于通知路由，不要写进正文或其他位置。"
)

_SILENT_SUFFIX_PATTERN = re.compile(
    r"\s*(?:\[\s*(?:静默|silent)\s*\]|【\s*(?:静默|silent)\s*】)\s*$",
    re.IGNORECASE,
)
_MENTION_SUFFIX_PATTERN = re.compile(
    r"\s*(?:\[\s*(?:@\s*列表\s*[:：]\s*|mention\s*[:：]?\s*|@\s*)"
    r"([^\]\n]+?)\s*\]|"
    r"【\s*(?:@\s*列表\s*[:：]\s*|mention\s*[:：]?\s*|@\s*)"
    r"([^】\n]+?)\s*】)\s*$",
    re.IGNORECASE,
)
_MENTION_ID_SPLIT_PATTERN = re.compile(r"[,，;；\s]+")
_MENTION_ID_EDGE_PUNCTUATION = " \t\r\n@:：,，;；.。!！?？"


@dataclass(frozen=True)
class NotificationDirectives:
    """Notification routing controls extracted from the message tail."""

    content: str
    silent: bool = False
    mention_staff_ids: tuple[str, ...] = ()


def _normalize_mention_ids(raw: str) -> list[str]:
    """Normalize one comma-separated mention payload."""
    result: list[str] = []
    for part in _MENTION_ID_SPLIT_PATTERN.split(raw):
        user_id = part.strip(_MENTION_ID_EDGE_PUNCTUATION)
        if not user_id:
            continue
        head, separator, display_name = user_id.replace("：", ":").partition(":")
        head = head.strip(_MENTION_ID_EDGE_PUNCTUATION)
        if not head:
            continue
        if separator and display_name.strip():
            result.append(f"{head}:{display_name.strip(_MENTION_ID_EDGE_PUNCTUATION)}")
        else:
            result.append(head)
    return result


def _consume_trailing_controls(line: str) -> tuple[str, bool, list[str]]:
    """Remove control tokens at the end of one line."""
    remaining = line.rstrip()
    silent = False
    mention_ids: list[str] = []

    while remaining:
        silent_match = _SILENT_SUFFIX_PATTERN.search(remaining)
        if silent_match:
            silent = True
            remaining = remaining[: silent_match.start()].rstrip()
            continue

        mention_match = _MENTION_SUFFIX_PATTERN.search(remaining)
        if mention_match:
            mention_ids.extend(
                _normalize_mention_ids(
                    mention_match.group(1) or mention_match.group(2) or ""
                )
            )
            remaining = remaining[: mention_match.start()].rstrip()
            continue

        break

    return remaining, silent, mention_ids


def _dedupe(values: list[str]) -> tuple[str, ...]:
    """Return unique values while preserving their first-seen order."""
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return tuple(result)


def parse_notification_directives(message: str | None) -> NotificationDirectives:
    """Extract and remove trailing silent/mention controls from a message.

    Only standalone control tokens at the end of the message are consumed.
    Mentions in the body and earlier lines remain ordinary content.
    """
    if not message:
        return NotificationDirectives(content="")

    lines = message.rstrip().splitlines()
    silent = False
    mention_ids: list[str] = []

    while lines:
        line = lines[-1]
        if not line.strip():
            if silent or mention_ids:
                lines.pop()
                continue
            break

        remainder, line_silent, line_mentions = _consume_trailing_controls(line)
        if not line_silent and not line_mentions:
            break

        silent = silent or line_silent
        mention_ids.extend(line_mentions)
        if remainder:
            lines[-1] = remainder
            break
        lines.pop()

    return NotificationDirectives(
        content="\n".join(lines).strip(),
        silent=silent,
        mention_staff_ids=_dedupe(mention_ids),
    )


def strip_notification_directives(message: str | None) -> str:
    """Return message content without trailing notification controls."""
    return parse_notification_directives(message).content


def has_group_notification_binding(
    subscription_json: Mapping[str, Any] | None,
) -> bool:
    """Return whether a subscription currently targets a bound group chat."""
    if not subscription_json:
        return False
    internal = subscription_json.get("_internal")
    if not isinstance(internal, Mapping):
        return False
    bindings = internal.get("notification_channel_bindings")
    if not isinstance(bindings, Mapping):
        return False
    return any(
        isinstance(config, Mapping)
        and bool(config.get("bind_group"))
        and bool(config.get("group_conversation_id"))
        for config in bindings.values()
    )


def append_group_notification_instruction(
    prompt: str, subscription_json: Mapping[str, Any] | None
) -> str:
    """Append group delivery controls only when a group chat is bound."""
    if not has_group_notification_binding(subscription_json):
        return prompt
    return f"{prompt.rstrip()}\n\n---\n\n{GROUP_NOTIFICATION_CONTROL_INSTRUCTION}"
