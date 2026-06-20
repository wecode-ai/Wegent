# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState
from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.services.channels.callback import BaseCallbackInfo, ChannelType
from app.services.channels.commands import IM_CHANNEL_CONTEXT_HINT
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.im.session_service import im_session_service


class FakeChannelHandler(BaseChannelHandler[dict[str, Any], BaseCallbackInfo]):
    def __init__(self, user: User):
        super().__init__(ChannelType.DINGTALK, channel_id=77)
        self.user = user
        self.replies: list[str] = []

    def parse_message(self, raw_data: dict[str, Any]) -> MessageContext:
        return MessageContext(
            content=raw_data.get("content", ""),
            sender_id=raw_data.get("sender_id", "staff-a"),
            sender_name=raw_data.get("sender_name", "Alice"),
            conversation_id=raw_data.get("conversation_id", "conv-private"),
            conversation_type=raw_data.get("conversation_type", "private"),
            is_mention=raw_data.get("is_mention", False),
            raw_message=raw_data,
            extra_data=raw_data.get("extra_data", {}),
            images=raw_data.get("images", []),
            files=raw_data.get("files", []),
        )

    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> User | None:
        return db.get(User, self.user.id)

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        self.replies.append(text)
        return True

    def create_callback_info(self, message_context: MessageContext) -> BaseCallbackInfo:
        return BaseCallbackInfo(
            channel_type=self.channel_type,
            channel_id=self.channel_id,
            conversation_id=message_context.conversation_id,
        )

    def get_callback_service(self):
        return None

    async def create_streaming_emitter(self, message_context: MessageContext):
        return None


@pytest.fixture()
def channel_sessionlocal(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
):
    factory = sessionmaker(
        bind=test_db.get_bind(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )
    monkeypatch.setattr("app.services.channels.handler.SessionLocal", factory)
    return factory


def _message(
    content: str,
    *,
    conversation_type: str = "private",
    conversation_id: str = "conv-private",
    images: list[dict[str, str]] | None = None,
    files: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "content": content,
        "conversation_type": conversation_type,
        "conversation_id": conversation_id,
        "sender_id": "staff-a",
        "sender_name": "Alice",
        "images": images or [],
        "files": files or [],
    }


def _private_session(test_db: Session, test_user: User) -> IMPrivateSession | None:
    return (
        test_db.query(IMPrivateSession)
        .filter(
            IMPrivateSession.user_id == test_user.id,
            IMPrivateSession.channel_type == "dingtalk",
            IMPrivateSession.channel_id == 77,
            IMPrivateSession.conversation_id == "conv-private",
        )
        .first()
    )


def _create_wework_task(
    test_db: Session,
    test_user: User,
    *,
    title: str = "修复 IM 任务路由",
) -> TaskResource:
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name=f"task-{title}",
        namespace="default",
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=False,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": f"task-{title}",
                "namespace": "default",
                "labels": {"taskType": "chat"},
            },
            "spec": {
                "title": title,
                "prompt": title,
                "teamRef": {
                    "name": "wegent-wework",
                    "namespace": "default",
                    "user_id": test_user.id,
                },
                "workspaceRef": {"name": "workspace-test", "namespace": "default"},
                "is_group_chat": False,
            },
            "status": {"status": "COMPLETED"},
        },
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    return task


def _create_team(test_db: Session, test_user: User) -> Kind:
    team = Kind(
        user_id=test_user.id,
        kind="Team",
        name="wegent-wework",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "wegent-wework", "namespace": "default"},
            "spec": {"displayName": "Wegent Wework", "members": []},
        },
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


@pytest.mark.asyncio
async def test_private_bind_creates_session_and_replies_bound(
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    handler = FakeChannelHandler(test_user)

    handled = await handler.handle_message(_message("/bind"))

    test_db.expire_all()
    session = _private_session(test_db, test_user)
    assert handled is True
    assert session is not None
    assert session.sender_id == "staff-a"
    assert session.display_name == "Alice"
    assert any("已绑定" in reply for reply in handler.replies)


@pytest.mark.asyncio
async def test_group_bind_does_not_create_private_session_and_uses_fallback(
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    handler = FakeChannelHandler(test_user)

    handled = await handler.handle_message(
        _message("/bind", conversation_type="group", conversation_id="conv-group")
    )

    assert handled is True
    assert test_db.query(IMPrivateSession).count() == 0
    assert handler.replies == [
        "请在私聊会话中使用该命令；任务模式正在初始化，请稍后重试。"
    ]


@pytest.mark.asyncio
async def test_private_task_then_numeric_choice_binds_recent_task_and_clears_pending(
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    task = _create_wework_task(test_db, test_user, title="整理私聊需求")
    handler = FakeChannelHandler(test_user)

    first_handled = await handler.handle_message(_message("/task"))
    second_handled = await handler.handle_message(_message("1"))

    test_db.expire_all()
    session = _private_session(test_db, test_user)
    assert first_handled is True
    assert second_handled is True
    assert session is not None
    assert session.mode == IMSessionMode.TASK
    assert session.active_task_id == task.id
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}
    assert any("最近任务" in reply for reply in handler.replies)
    assert any(
        "整理私聊需求" in reply and "已切换" in reply for reply in handler.replies
    )


@pytest.mark.asyncio
async def test_task_mode_plain_text_appends_to_active_task_with_im_source_metadata(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    _create_team(test_db, test_user)
    task = _create_wework_task(test_db, test_user, title="继续私聊任务")
    handler = FakeChannelHandler(test_user)
    session = im_session_service.get_or_create_private_session(
        test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
        sender_id="staff-a",
        display_name="Alice",
    )
    im_session_service.bind_active_task(test_db, session=session, task_id=task.id)

    calls: dict[str, Any] = {}

    async def fake_append_message_to_task(
        db: Session,
        *,
        user: User,
        task_id: int,
        message: str,
        message_source: dict[str, Any] | None,
    ):
        calls["append"] = {
            "task_id": task_id,
            "message": message,
            "message_source": message_source,
        }
        return SimpleNamespace(
            task=SimpleNamespace(id=task_id),
            user_subtask=SimpleNamespace(id=501),
            assistant_subtask=SimpleNamespace(id=502),
        )

    async def fake_trigger_ai_response_unified(**kwargs):
        calls["trigger"] = kwargs

    class FakeStreamingEmitter:
        async def emit_start(self, **kwargs):
            calls["emit_start"] = kwargs

        def set_shared_content_key(self, key: str):
            calls["shared_content_key"] = key

    async def fake_create_streaming_emitter(message_context: MessageContext):
        return FakeStreamingEmitter()

    monkeypatch.setattr(
        "app.services.im.task_continuation_service.append_message_to_task",
        fake_append_message_to_task,
    )
    monkeypatch.setattr(
        "app.services.chat.trigger.trigger_ai_response_unified",
        fake_trigger_ai_response_unified,
    )
    monkeypatch.setattr(
        handler,
        "create_streaming_emitter",
        fake_create_streaming_emitter,
    )

    handled = await handler.handle_message(_message("继续处理这个任务"))

    assert handled is True
    assert calls["append"]["task_id"] == task.id
    assert calls["append"]["message"] == "继续处理这个任务"
    assert calls["append"]["message_source"]["source"] == "im"
    assert calls["append"]["message_source"]["session_id"] == str(session.id)
    assert calls["append"]["message_source"]["channel_label"] == "钉钉"
    assert calls["trigger"]["task"].id == task.id
    assert calls["trigger"]["user_subtask_id"] == 501


@pytest.mark.asyncio
async def test_task_mode_media_only_message_appends_to_active_task_and_persists_media(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    _create_team(test_db, test_user)
    task = _create_wework_task(test_db, test_user, title="继续图片任务")
    handler = FakeChannelHandler(test_user)
    session = im_session_service.get_or_create_private_session(
        test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
        sender_id="staff-a",
        display_name="Alice",
    )
    im_session_service.bind_active_task(test_db, session=session, task_id=task.id)

    calls: dict[str, Any] = {}

    async def fake_append_message_to_task(
        db: Session,
        *,
        user: User,
        task_id: int,
        message: str,
        message_source: dict[str, Any] | None,
    ):
        calls["append"] = {
            "task_id": task_id,
            "message": message,
            "message_source": message_source,
        }
        return SimpleNamespace(
            task=SimpleNamespace(id=task_id),
            user_subtask=SimpleNamespace(id=601),
            assistant_subtask=SimpleNamespace(id=602),
        )

    async def fake_trigger_ai_response_unified(**kwargs):
        calls["trigger"] = kwargs

    class FakeStreamingEmitter:
        async def emit_start(self, **kwargs):
            calls["emit_start"] = kwargs

        def set_shared_content_key(self, key: str):
            calls["shared_content_key"] = key

    async def fake_create_streaming_emitter(message_context: MessageContext):
        return FakeStreamingEmitter()

    def fake_persist_images_as_attachments(
        db: Session,
        user_id: int,
        subtask_id: int,
        images: list[dict[str, str]],
    ):
        calls["persist_images"] = {
            "user_id": user_id,
            "subtask_id": subtask_id,
            "images": images,
        }
        return [9001]

    monkeypatch.setattr(
        "app.services.im.task_continuation_service.append_message_to_task",
        fake_append_message_to_task,
    )
    monkeypatch.setattr(
        "app.services.chat.trigger.trigger_ai_response_unified",
        fake_trigger_ai_response_unified,
    )
    monkeypatch.setattr(
        handler,
        "create_streaming_emitter",
        fake_create_streaming_emitter,
    )
    monkeypatch.setattr(
        handler,
        "_persist_im_images_as_attachments",
        fake_persist_images_as_attachments,
    )

    image = {"mime_type": "image/png", "base64_data": "aGVsbG8="}
    handled = await handler.handle_message(_message("", images=[image]))

    assert handled is True
    assert calls["append"]["task_id"] == task.id
    assert calls["append"]["message"] == ""
    assert calls["append"]["message_source"]["source"] == "im"
    assert calls["persist_images"] == {
        "user_id": test_user.id,
        "subtask_id": 601,
        "images": [image],
    }
    assert calls["trigger"]["task"].id == task.id
    assert calls["trigger"]["message"] == IM_CHANNEL_CONTEXT_HINT


@pytest.mark.asyncio
async def test_private_task_creation_uses_task_type_task_and_binds_new_task(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    team = _create_team(test_db, test_user)
    handler = FakeChannelHandler(test_user)
    calls: dict[str, Any] = {}

    async def fake_create_chat_task(
        db: Session,
        user: User,
        team: Kind,
        message: str,
        params: Any,
        task_id: int | None = None,
        should_trigger_ai: bool = True,
        rag_prompt: str | None = None,
        source: str = "web",
    ):
        calls["create"] = {
            "message": message,
            "params": params,
            "should_trigger_ai": should_trigger_ai,
            "source": source,
        }
        return SimpleNamespace(
            task=SimpleNamespace(id=710),
            user_subtask=SimpleNamespace(id=711),
            assistant_subtask=SimpleNamespace(id=712),
        )

    async def fake_trigger_ai_response_unified(**kwargs):
        calls["trigger"] = kwargs

    class FakeStreamingEmitter:
        async def emit_start(self, **kwargs):
            calls["emit_start"] = kwargs

        def set_shared_content_key(self, key: str):
            calls["shared_content_key"] = key

    async def fake_create_streaming_emitter(message_context: MessageContext):
        return FakeStreamingEmitter()

    monkeypatch.setattr(
        handler,
        "_get_task_mode_team",
        lambda db, user_id: team,
    )
    monkeypatch.setattr(
        "app.services.chat.storage.task_manager.create_chat_task",
        fake_create_chat_task,
    )
    monkeypatch.setattr(
        "app.services.chat.trigger.trigger_ai_response_unified",
        fake_trigger_ai_response_unified,
    )
    monkeypatch.setattr(
        handler,
        "create_streaming_emitter",
        fake_create_streaming_emitter,
    )

    await handler.handle_message(_message("/task"))
    await handler.handle_message(_message("new"))
    await handler.handle_message(_message("0"))
    handled = await handler.handle_message(_message("创建新的任务需求"))

    test_db.expire_all()
    session = _private_session(test_db, test_user)
    assert handled is True
    assert calls["create"]["message"] == "创建新的任务需求"
    assert calls["create"]["params"].task_type == "task"
    assert calls["create"]["params"].client_origin == CLIENT_ORIGIN_WEWORK
    assert calls["create"]["params"].source == "im"
    assert calls["create"]["should_trigger_ai"] is True
    assert calls["create"]["source"] == "im"
    assert session is not None
    assert session.active_task_id == 710
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}
