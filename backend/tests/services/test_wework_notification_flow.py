"""End-to-end notification flow with only the DingTalk transport substituted.

The comment service, the execution lifecycle, the commit hook, the delivery
scheduler, the IM dispatcher and the markdown rendering all run for real; only
the outbound DingTalk HTTP call is replaced, so these cases assert what the
recipient actually receives in DingTalk.
"""

import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.loop_item_execution import LoopItemExecution
from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import ProjectChatSend
from app.services.im.session_service import im_session_service
from app.services.loop_item_executions.notification import notify_execution_lifecycle
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.service import project_chat_service
from app.services.wework_notifications import deliver_notification
from shared.utils.crypto import encrypt_sensitive_data
from tests.services.im.test_notification_dispatcher import (
    _create_channel,
    _create_session,
)
from tests.services.test_loop_item_assignment import (
    _make_item,
    _make_member,
    _make_project,
)

CHANNEL_ID = 9_612_001


class FakeDingTalkSender:
    """Capture what DingTalk would deliver instead of calling the open API."""

    sent: list[dict[str, Any]] = []

    def __init__(self, client_id: str, client_secret: str) -> None:
        self.client_id = client_id

    async def send_text_message(self, user_ids: list[str], content: str):
        FakeDingTalkSender.sent.append({"user_ids": user_ids, "text": content})
        return {"success": True, "result": {"processQueryKey": self._key()}}

    async def send_markdown_message(self, user_ids: list[str], title: str, text: str):
        FakeDingTalkSender.sent.append(
            {"user_ids": user_ids, "title": title, "text": text}
        )
        return {"success": True, "result": {"processQueryKey": self._key()}}

    @staticmethod
    def _key() -> str:
        return f"query-{len(FakeDingTalkSender.sent)}"


@pytest.fixture(autouse=True)
def isolate_im_session_cache(fake_im_session_cache: Any) -> Any:
    """Keep the dispatcher from mutating the developer's Redis state."""

    return fake_im_session_cache


@pytest.fixture(autouse=True)
def dingtalk_recipient(monkeypatch: pytest.MonkeyPatch):
    """Deliver into the capture list, and never schedule background delivery."""

    FakeDingTalkSender.sent = []
    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkSender,
    )
    monkeypatch.setattr(
        "app.core.async_utils.schedule_async_task",
        lambda *_args, **_kwargs: None,
    )


async def connect_dingtalk(db: Session, user_id: int) -> None:
    """Give one recipient a connected bot with proactive private messages on."""

    _create_channel(
        db,
        channel_id=CHANNEL_ID,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=user_id,
        channel_id=CHANNEL_ID,
        channel_type="dingtalk",
        sender_id=f"sender-{user_id}",
        proactive_recipient_id=f"staff-{user_id}",
    )
    await im_session_service.save_session(session)
    await im_session_service.enable_global_notification(db, session=session)
    db.commit()


async def deliver(db: Session, notification: WeworkNotification) -> None:
    """Run the real delivery path for one inbox row."""

    with (
        patch("app.db.session.SessionLocal", return_value=db),
        patch(
            "app.core.socketio.get_sio",
            return_value=SimpleNamespace(emit=AsyncMock()),
        ),
    ):
        await deliver_notification(notification.id)


def dingtalk_preview(headline: str, limit: int = 20) -> str:
    """The single-line title DingTalk shows in the contact list."""

    collapsed = " ".join(headline.split()).strip()
    return collapsed if len(collapsed) <= limit else f"{collapsed[:limit]}…"


def fact_block(*facts: str) -> str:
    """The blank-line separated ``标签：值`` block a push renders."""

    return "\n\n".join(facts)


async def test_mentioning_a_member_pushes_the_comment_to_dingtalk(
    test_db: Session, test_user
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    mentioner = _make_member(test_db, project, "mentioner", BaseRole.Developer)
    recipient = _make_member(test_db, project, "recipient", BaseRole.Developer)
    await connect_dingtalk(test_db, recipient.id)

    result = project_chat_service.send(
        test_db,
        user_id=mentioner.id,
        user_name=mentioner.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=item.id,
            content="@recipient 这个改动麻烦你确认下",
            mentions=[
                {"type": "user", "id": str(recipient.id), "label": recipient.user_name}
            ],
        ),
    )

    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.user_id == recipient.id)
        .one()
    )
    assert notification.kind == "mention"
    assert notification.url == (
        f"wework://boards/{project.id}/issues/{item.id}"
        f"/comments/{result.message.message_id}"
    )
    assert notification.payload["commentId"] == result.message.message_id
    assert notification.payload["itemTitle"] == item.title

    await deliver(test_db, notification)

    headline = "mentioner 在评论中提到了你"
    web_link = (
        f"{settings.FRONTEND_URL.rstrip('/')}/collaboration/{project.id}"
        f"/issues/{item.id}"
    )
    assert FakeDingTalkSender.sent == [
        {
            "user_ids": [f"staff-{recipient.id}"],
            "title": dingtalk_preview(headline),
            "text": (
                f"**{headline}**\n\n"
                + fact_block(
                    f"任务标题：{item.title}",
                    f"任务编号：{item.id}",
                    "任务状态：收集箱",
                    f"看板：{project.name}",
                    "评论内容：@recipient 这个改动麻烦你确认下",
                )
                + f"\n\n[在 Wework 打开]({notification.url})"
                f" · [在浏览器打开]({web_link})"
            ),
        }
    ]


async def test_execution_lifecycle_pushes_start_blocked_and_end(
    test_db: Session, test_user
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    assignee = _make_member(test_db, project, "runowner", BaseRole.Developer)
    item.assignee_user_id = assignee.id
    test_db.commit()
    await connect_dingtalk(test_db, assignee.id)

    pushed: dict[str, dict[str, Any]] = {}
    for status, content in (
        ("queued", ""),
        ("pending_approval", ""),
        ("completed", "实现完成，已通过自测。"),
    ):
        execution = LoopItemExecution(
            loop_item_id=item.id,
            cloud_project_id=str(project.id),
            executor_owner_user_id=test_user.id,
            status=status,
        )
        test_db.add(execution)
        test_db.commit()
        notify_execution_lifecycle(
            test_db, execution=execution, status=status, content=content
        )
        test_db.commit()
        notification = (
            test_db.query(WeworkNotification)
            .filter(WeworkNotification.user_id == assignee.id)
            .order_by(WeworkNotification.created_at.desc())
            .first()
        )
        assert notification is not None
        await deliver(test_db, notification)
        pushed[status] = FakeDingTalkSender.sent[-1]

    destination = f"wework://boards/{project.id}/issues/{item.id}"
    assert pushed["queued"]["title"] == "你的任务已开始执行"
    assert pushed["pending_approval"]["title"] == "你的任务等待你审批"
    assert pushed["completed"]["title"] == "你的任务已完成"
    assert pushed["completed"]["text"] == (
        "**你的任务已完成**\n\n"
        + fact_block(
            f"任务标题：{item.title}",
            f"任务编号：{item.id}",
            "任务状态：已完成",
            f"当前负责人：{assignee.user_name}",
            f"看板：{project.name}",
            "任务结果：实现完成，已通过自测。",
        )
        + f"\n\n[在 Wework 打开]({destination})"
        f" · [在浏览器打开]({settings.FRONTEND_URL.rstrip('/')}"
        f"/collaboration/{project.id}/issues/{item.id})"
    )
    assert all(
        message["user_ids"] == [f"staff-{assignee.id}"] for message in pushed.values()
    )


async def test_failed_run_pushes_the_reason_the_engine_recorded(
    test_db: Session, test_user
) -> None:
    """A failure notice carries the reason the execution itself recorded."""

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    assignee = _make_member(test_db, project, "runowner", BaseRole.Developer)
    item.assignee_user_id = assignee.id
    test_db.commit()
    await connect_dingtalk(test_db, assignee.id)

    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        executor_owner_user_id=test_user.id,
        status="running",
    )
    test_db.add(execution)
    test_db.commit()

    loop_item_execution_service.fail(
        test_db,
        execution_id=execution.id,
        error="Error: 构建镜像失败：no space left on device",
    )

    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.user_id == assignee.id)
        .one()
    )
    await deliver(test_db, notification)

    pushed = FakeDingTalkSender.sent[-1]
    assert pushed["title"] == "你的任务执行未成功"
    assert "失败原因：Error: 构建镜像失败：no space left on device" in pushed["text"]
    assert notification.payload["status"] == "failed"
