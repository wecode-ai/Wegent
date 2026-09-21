"""The shared notification copy keeps every kind readable on its own."""

from app.services.notification_copy import (
    assignment_copy,
    mention_copy,
    notification_message,
    runtime_update_copy,
)


def test_mention_copy_names_the_actor_item_and_board() -> None:
    copy = mention_copy(
        actor_name="hajimi",
        item_title="修复登录",
        project_name="test-pro",
        preview="你那边方便看下吗？",
    )

    assert copy.title == "hajimi 在「修复登录」提到了你"
    assert copy.body == "你那边方便看下吗？\n\n看板：test-pro"


def test_mention_copy_without_item_or_board_stays_readable() -> None:
    copy = mention_copy(
        actor_name="hajimi",
        item_title=None,
        project_name=None,
        preview="hi",
    )

    assert copy.title == "hajimi 在评论中提到了你"
    assert copy.body == "hi"


def test_assignment_copy_leads_with_the_assigner() -> None:
    copy = assignment_copy(
        assigner_name="admin",
        item_title="修复登录",
        project_name="test-pro",
    )

    assert copy.title == "admin 把「修复登录」分配给了你"
    assert copy.body == "看板：test-pro"


def test_runtime_update_copy_reuses_one_headline_shape() -> None:
    assert (
        runtime_update_copy(
            task_title="重构通知", status="waiting_user_input", content=""
        ).title
        == "任务「重构通知」需要你确认"
    )
    assert (
        runtime_update_copy(task_title="重构通知", status="failed", content="").title
        == "任务「重构通知」执行失败"
    )
    assert (
        runtime_update_copy(task_title="重构通知", status="cancelled", content="").title
        == "任务「重构通知」已取消"
    )
    assert (
        runtime_update_copy(
            task_title="重构通知", status="updated", content="改好了"
        ).title
        == "任务「重构通知」有新的 AI 回复"
    )


def test_notification_message_keeps_the_headline_above_the_detail() -> None:
    assert notification_message("标题", "正文") == "标题\n\n正文"
    assert notification_message("标题", "") == "标题"
    assert notification_message("", "正文") == "正文"
