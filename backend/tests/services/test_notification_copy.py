"""Every notification keeps its copy and its payload in one shared shape."""

from app.services.notification_copy import (
    NotificationTarget,
    assignment_message,
    comment_preview,
    execution_message,
    mention_message,
    notification_message,
    runtime_message,
)

TARGET = NotificationTarget(
    project_id="12",
    project_name="test-pro",
    item_id="WEG-12",
    item_key="WEG-12",
    item_title="修复登录",
    item_status="进行中",
    item_priority="high",
    item_due_at="2026-09-30T00:00:00",
)


def test_mention_message_names_the_actor_item_and_landing_comment() -> None:
    message = mention_message(
        actor_name="hajimi",
        preview="麻烦看下这个改动",
        comment_id="comment-1",
        target=TARGET,
        reply_preview="上一条的结论",
    )

    assert message.kind == "mention"
    assert message.title == "hajimi 在「修复登录」提到了你"
    assert message.body == "麻烦看下这个改动\n\n看板：test-pro"
    assert message.comment_id == "comment-1"
    assert message.payload == {
        "projectId": "12",
        "projectName": "test-pro",
        "itemId": "WEG-12",
        "itemKey": "WEG-12",
        "itemTitle": "修复登录",
        "itemStatus": "进行中",
        "itemPriority": "high",
        "itemDueAt": "2026-09-30T00:00:00",
        "actorName": "hajimi",
        "commentId": "comment-1",
        "commentPreview": "麻烦看下这个改动",
        "replyPreview": "上一条的结论",
    }


def test_mention_message_without_a_reply_omits_the_reply_preview() -> None:
    message = mention_message(
        actor_name="hajimi",
        preview="hi",
        comment_id="comment-1",
        target=NotificationTarget(project_id="12", project_name="test-pro"),
    )

    assert message.title == "hajimi 在评论中提到了你"
    assert message.body == "hi\n\n看板：test-pro"
    assert "replyPreview" not in message.payload


def test_assignment_message_carries_the_priority_and_due_date() -> None:
    message = assignment_message(assigner_name="admin", target=TARGET)

    assert message.title == "admin 把「修复登录」分配给了你"
    assert message.body == "看板：test-pro"
    assert message.payload["itemPriority"] == "high"
    assert message.payload["itemDueAt"] == "2026-09-30T00:00:00"
    assert message.payload["actorName"] == "admin"


def test_execution_message_uses_one_headline_per_state() -> None:
    titles = {
        status: execution_message(target=TARGET, status=status).title
        for status in (
            "queued",
            "pending_approval",
            "waiting_runtime",
            "completed",
            "failed",
            "cancelled",
        )
    }

    assert titles == {
        "queued": "「修复登录」已开始执行",
        "pending_approval": "「修复登录」等待你审批",
        "waiting_runtime": "「修复登录」需要选择运行设备",
        "completed": "「修复登录」已完成",
        "failed": "「修复登录」执行未成功",
        "cancelled": "「修复登录」已取消",
    }
    failed = execution_message(target=TARGET, status="failed", detail="构建失败")
    assert failed.body == "构建失败\n\n看板：test-pro"
    assert failed.payload["status"] == "failed"


def test_runtime_message_mirrors_the_board_headline_shape() -> None:
    assert (
        runtime_message(task_title="重构通知", status="completed", content="").title
        == "任务「重构通知」已完成"
    )
    assert (
        runtime_message(task_title="重构通知", status="updated", content="改好了").body
        == "改好了"
    )


def test_notification_message_keeps_the_headline_above_the_detail() -> None:
    assert notification_message("标题", "正文") == "标题\n\n正文"
    assert notification_message("标题", "") == "标题"
    assert notification_message("", "正文") == "正文"


def test_comment_preview_collapses_whitespace_and_truncates() -> None:
    assert comment_preview("a\n\nb   c") == "a b c"
    assert comment_preview("x" * 30, limit=10) == "xxxxxxxxx…"
