# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

from app.services.channels.dingtalk.notification_card import (
    BUTTONS_KEY,
    CONTENT_KEY,
    FINISHED_FLOW_STATUS,
    STATIC_CONTENT_KEY,
    TITLE_KEY,
    card_param_map,
)
from app.services.notification_copy import (
    NotificationLink,
    NotificationTarget,
    execution_message,
    mention_message,
    push_copy,
)

TARGET = NotificationTarget(
    project_id="12",
    project_name="test-pro",
    item_id="WEG-12",
    item_key="WEG-12",
    item_title="修复登录",
    item_status="进行中",
    assignee_name="崔嘉琪",
)

LINKS = [
    NotificationLink(label="在 Wework 打开", url="wework://boards/12/issues/ISSUE-1"),
    NotificationLink(
        label="在浏览器打开",
        url="http://localhost:3000/collaboration/12/issues/ISSUE-1",
    ),
]


def test_card_carries_its_finished_body_and_both_destinations() -> None:
    """A pushed card has no later frame, so the body ships with the card."""

    message = mention_message(
        actor_name="hajimi",
        preview="麻烦看下这个改动",
        comment_id="comment-1",
        target=TARGET,
    )
    params = card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        ),
        links=LINKS,
    )

    assert params[TITLE_KEY] == "🔔 hajimi 在评论中提到了你"
    assert params[STATIC_CONTENT_KEY] == params[CONTENT_KEY]
    assert params["flowStatus"] == FINISHED_FLOW_STATUS
    full_json = json.loads(params["sys_full_json_obj"])
    assert full_json["order"] == [
        TITLE_KEY,
        CONTENT_KEY,
        STATIC_CONTENT_KEY,
        BUTTONS_KEY,
    ]
    assert full_json[BUTTONS_KEY] == [
        {
            "text": "在 Wework 打开",
            "url": "wework://boards/12/issues/ISSUE-1",
            "color": "blue",
        },
        {
            "text": "在浏览器打开",
            "url": "http://localhost:3000/collaboration/12/issues/ISSUE-1",
            "color": "gray",
        },
    ]


def test_card_without_destinations_leaves_the_button_row_out() -> None:
    params = card_param_map(
        push=push_copy(kind="message", title="提到了你", body="看板：test-pro")
    )

    assert BUTTONS_KEY not in json.loads(params["sys_full_json_obj"])


def test_card_bolds_every_label_so_a_key_never_reads_as_its_value() -> None:
    message = execution_message(
        target=TARGET, status="completed", detail="实现完成，已通过自测。"
    )

    params = card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        )
    )

    assert params[STATIC_CONTENT_KEY] == (
        "**任务标题**：修复登录\n"
        "**任务编号**：WEG-12\n"
        "**任务状态**：已完成\n"
        "**当前负责人**：崔嘉琪\n"
        "**看板**：test-pro\n"
        "\n"
        "**任务结果**\n"
        "> 实现完成，已通过自测。"
    )


def test_card_escapes_a_comment_but_not_its_own_labels() -> None:
    """A member's words must not render as markup inside the card."""

    message = mention_message(
        actor_name="hajimi",
        preview="[点这里](https://tracker.example/login)",
        comment_id="comment-1",
        target=TARGET,
    )

    params = card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        )
    )

    assert (
        "**评论内容**\n> \\[点这里\\](https://tracker.example/login)"
        in params[STATIC_CONTENT_KEY]
    )


def test_card_quotes_every_line_of_a_multiline_result() -> None:
    message = execution_message(
        target=TARGET, status="failed", detail="第 1 步失败\nno space left on device"
    )

    params = card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        )
    )

    assert params[STATIC_CONTENT_KEY].endswith(
        "**失败原因**\n> 第 1 步失败\n> no space left on device"
    )
