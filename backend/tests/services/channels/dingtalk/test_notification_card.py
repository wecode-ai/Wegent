# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from app.services.channels.dingtalk.notification_card import (
    BUTTONS_KEY,
    MARKDOWN_KEY,
    MAX_CARD_DETAIL_CHARS,
    TIPS_KEY,
    TITLE_KEY,
    card_param_map,
)
from app.services.notification_copy import (
    NotificationLink,
    NotificationTarget,
    assignment_message,
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
    NotificationLink(label="在 Wework 中打开", url="wework://boards/12/issues/ISSUE-1"),
    NotificationLink(
        label="查看任务",
        url="http://localhost:3000/collaboration/12/issues/ISSUE-1",
    ),
]


def _mention_params() -> dict[str, str]:
    message = mention_message(
        actor_name="hajimi",
        preview="麻烦看下这个改动",
        comment_id="comment-1",
        target=TARGET,
    )
    return card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        ),
        links=LINKS,
    )


def test_card_paints_the_headline_in_the_template_header() -> None:
    """The header slot is the only text the template draws larger than the body."""

    params = _mention_params()

    assert params[TITLE_KEY] == "🔔 hajimi 在评论中提到了你"
    assert params[MARKDOWN_KEY].startswith(
        "**任务标题**：修复登录\n**任务编号**：WEG-12"
    )
    assert params[MARKDOWN_KEY].endswith("**评论内容**\n> 麻烦看下这个改动")
    assert params[TIPS_KEY] == ""
    assert json.loads(params["sys_full_json_obj"])[BUTTONS_KEY] == [
        {
            "text": "在 Wework 中打开",
            "url": "wework://boards/12/issues/ISSUE-1",
            "color": "blue",
        },
        {
            "text": "查看任务",
            "url": "http://localhost:3000/collaboration/12/issues/ISSUE-1",
            "color": "gray",
        },
    ]


def test_card_without_destinations_has_no_button_row() -> None:
    params = card_param_map(
        push=push_copy(kind="message", title="提到了你", body="看板：test-pro")
    )

    assert "sys_full_json_obj" not in params


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

    assert params[TITLE_KEY] == "✅ 你的任务已完成"
    assert params[MARKDOWN_KEY] == (
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
        in params[MARKDOWN_KEY]
    )


def test_card_keeps_a_members_name_verbatim_in_the_plain_header() -> None:
    """The header slot is plain text, so a member's name is left as typed."""

    message = mention_message(
        actor_name="[x](https://tracker.example/login)",
        preview="hi",
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

    assert params[TITLE_KEY] == (
        "🔔 [x](https://tracker.example/login) 在评论中提到了你"
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

    assert params[MARKDOWN_KEY].endswith(
        "**失败原因**\n> 第 1 步失败\n> no space left on device"
    )


def test_custom_card_exposes_a_mention_as_separate_plain_text_fields() -> None:
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
        ),
        links=LINKS,
        card_template_id="wegent-custom-template",
    )

    assert params == {
        "kindLabel": "评论提及",
        "tone": "blue",
        "headline": "hajimi 在评论中提到了你",
        "itemTitle": "修复登录",
        "itemKey": "WEG-12",
        "metaLine": "test-pro · 进行中 · 负责人：崔嘉琪",
        "detailLabel": "评论内容",
        "detail": "[点这里](https://tracker.example/login)",
        "showDetail": "true",
        "primaryLabel": "查看任务",
        "primaryUrl": "http://localhost:3000/collaboration/12/issues/ISSUE-1",
        "secondaryLabel": "在 Wework 中打开",
        "secondaryUrl": "wework://boards/12/issues/ISSUE-1",
    }


def test_custom_card_hides_missing_assignment_detail_and_links() -> None:
    message = assignment_message(
        assigner_name="admin",
        target=NotificationTarget(project_id="12", project_name="test-pro"),
    )

    params = card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        ),
        card_template_id="wegent-custom-template",
    )

    assert params["kindLabel"] == "任务分配"
    assert params["tone"] == "blue"
    assert params["headline"] == "admin 把任务分配给了你"
    assert params["itemTitle"] == ""
    assert params["itemKey"] == ""
    assert params["metaLine"] == "test-pro"
    assert params["detail"] == ""
    assert params["showDetail"] == "false"
    assert params["primaryUrl"] == ""
    assert params["secondaryUrl"] == ""


@pytest.mark.parametrize(
    ("status", "kind_label", "tone"),
    [
        ("queued", "已入队", "blue"),
        ("claimed", "准备执行", "blue"),
        ("running", "执行中", "blue"),
        ("pending_approval", "待审批", "orange"),
        ("waiting_user_input", "待确认", "orange"),
        ("waiting_runtime", "待选设备", "orange"),
        ("completed", "已完成", "green"),
        ("failed", "执行失败", "red"),
        ("FAILED", "执行失败", "red"),
        ("cancelled", "已取消", "gray"),
    ],
)
def test_custom_card_presents_execution_state(
    status: str, kind_label: str, tone: str
) -> None:
    message = execution_message(target=TARGET, status=status)

    params = card_param_map(
        push=push_copy(
            kind=message.kind,
            title=message.title,
            body=message.body,
            payload=message.payload,
        ),
        card_template_id="wegent-custom-template",
    )

    assert (params["kindLabel"], params["tone"]) == (kind_label, tone)
    assert params["detail"]
    assert params["showDetail"] == "true"


def test_custom_card_limits_a_long_result_without_changing_the_push() -> None:
    message = execution_message(
        target=TARGET, status="completed", detail="结果" * MAX_CARD_DETAIL_CHARS
    )
    push = push_copy(
        kind=message.kind,
        title=message.title,
        body=message.body,
        payload=message.payload,
    )

    params = card_param_map(push=push, card_template_id="wegent-custom-template")

    assert len(params["detail"]) == MAX_CARD_DETAIL_CHARS
    assert params["detail"].endswith("…")
    assert push.detail == "结果" * MAX_CARD_DETAIL_CHARS
