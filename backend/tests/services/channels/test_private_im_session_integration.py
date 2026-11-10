# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.services.channels.callback import BaseCallbackInfo, ChannelType
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.im.session_service import im_session_service


class FakeChannelHandler(BaseChannelHandler[dict[str, Any], BaseCallbackInfo]):
    def __init__(self, user: User, channel_type: ChannelType = ChannelType.DINGTALK):
        super().__init__(channel_type, channel_id=77)
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
            proactive_recipient_id=raw_data.get("proactive_recipient_id"),
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


@pytest.fixture()
def expiring_channel_sessionlocal(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
):
    factory = sessionmaker(
        bind=test_db.get_bind(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=True,
    )
    monkeypatch.setattr("app.services.channels.handler.SessionLocal", factory)
    return factory


def _message(
    content: str,
    *,
    conversation_type: str = "private",
    conversation_id: str = "conv-private",
    proactive_recipient_id: str | None = None,
    extra_data: dict[str, Any] | None = None,
    images: list[dict[str, str]] | None = None,
    files: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "content": content,
        "conversation_type": conversation_type,
        "conversation_id": conversation_id,
        "sender_id": "staff-a",
        "sender_name": "Alice",
        "proactive_recipient_id": proactive_recipient_id,
        "extra_data": extra_data or {},
        "images": images or [],
        "files": files or [],
    }


async def _private_session(
    test_db: Session, test_user: User
) -> IMPrivateSession | None:
    return await im_session_service.get_session(
        im_session_service.build_session_key(
            user_id=test_user.id,
            channel_type="dingtalk",
            channel_id=77,
            conversation_id="conv-private",
        )
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
    sessions = await im_session_service.list_user_sessions(
        test_db, user_id=test_user.id
    )
    assert sessions == []
    assert handler.replies == ["该命令仅支持私聊，请在与机器人的私聊中使用。"]


@pytest.mark.asyncio
async def test_dingtalk_runtime_message_registers_started_card_for_cross_worker(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    from app.services import runtime_work_service

    handler = FakeChannelHandler(test_user)
    session = await im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="conv-private",
        sender_id="staff-a",
        display_name="Alice",
    )
    runtime_task = {
        "deviceId": "device-1",
        "workspacePath": "/repo/Wegent",
        "localTaskId": "codex-1",
    }
    calls: dict[str, Any] = {}

    class FakeCallbackService:
        async def save_callback_info(self, task_id, callback_info):
            calls["saved"] = (task_id, callback_info)

        async def register_emitter(self, task_id, emitter):
            calls["registered"] = (task_id, emitter)

    class FakeStreamingEmitter:
        card_instance_id = "card-instance-1"

        async def emit_start(self, **kwargs):
            calls["started"] = kwargs

        def set_shared_content_key(self, key: str):
            calls["shared_content_key"] = key

    emitter = FakeStreamingEmitter()

    async def fake_create_streaming_emitter(message_context):
        return emitter

    async def fake_send_runtime_message(**kwargs):
        calls["send"] = kwargs
        return SimpleNamespace(accepted=True, local_task_id="codex-1", error=None)

    monkeypatch.setattr(handler, "get_callback_service", lambda: FakeCallbackService())
    monkeypatch.setattr(
        handler,
        "create_callback_info",
        lambda context: SimpleNamespace(
            conversation_id=context.conversation_id,
            card_instance_id=None,
        ),
    )
    monkeypatch.setattr(
        handler,
        "create_streaming_emitter",
        fake_create_streaming_emitter,
    )
    monkeypatch.setattr(
        runtime_work_service,
        "send_runtime_message",
        fake_send_runtime_message,
    )

    handled = await handler._execute_private_im_continue_runtime_task(
        db=test_db,
        user=test_user,
        im_session=session,
        message="继续 runtime",
        message_context=handler.parse_message(
            _message("继续 runtime", extra_data={"message_id": "dingtalk-message-1"})
        ),
        runtime_task=runtime_task,
    )

    callback_key = "runtime:device-1:codex-1"
    assert handled is True
    assert calls["started"] == {"task_id": callback_key, "subtask_id": 0}
    assert calls["shared_content_key"] == (
        "channel:streaming_content:runtime:device-1:codex-1"
    )
    assert calls["saved"][0] == callback_key
    assert calls["saved"][1].card_instance_id == "card-instance-1"
    assert calls["registered"] == (callback_key, emitter)
    assert (
        calls["send"]["request"].client_user_message_id
        == "im:dingtalk:77:dingtalk-message-1"
    )


@pytest.mark.asyncio
async def test_weibo_runtime_message_registers_stream_without_status_prefix(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    channel_sessionlocal,
) -> None:
    from app.services import runtime_work_service

    handler = FakeChannelHandler(test_user, channel_type=ChannelType.WEIBO)
    session = await im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="weibo",
        channel_id=77,
        conversation_id="conv-private",
        sender_id="staff-a",
        display_name="Alice",
    )
    runtime_task = {
        "deviceId": "device-1",
        "workspacePath": "/repo/Wegent",
        "localTaskId": "codex-1",
    }
    calls: dict[str, Any] = {}

    class FakeCallbackService:
        async def save_callback_info(self, task_id, callback_info):
            calls["callback"] = {
                "task_id": task_id,
                "callback_info": callback_info,
            }

        async def register_emitter(self, task_id, emitter):
            calls["registered_emitter"] = {
                "task_id": task_id,
                "emitter": emitter,
            }

        async def delete_callback_info(self, task_id):
            calls["deleted_callback"] = task_id

    class FakeStreamingEmitter:
        async def emit_start(self, **kwargs):
            calls["emit_start"] = kwargs

        async def emit_status_prefix(self, **kwargs):
            calls["emit_status_prefix"] = kwargs

    async def fake_create_streaming_emitter(message_context: MessageContext):
        emitter = FakeStreamingEmitter()
        calls["created_emitter"] = emitter
        return emitter

    async def fake_send_runtime_message(**kwargs):
        calls["send"] = kwargs
        return SimpleNamespace(accepted=True, local_task_id="codex-1", error=None)

    monkeypatch.setattr(handler, "get_callback_service", lambda: FakeCallbackService())
    monkeypatch.setattr(
        handler,
        "create_streaming_emitter",
        fake_create_streaming_emitter,
    )
    monkeypatch.setattr(
        runtime_work_service,
        "send_runtime_message",
        fake_send_runtime_message,
    )

    handled = await handler._execute_private_im_continue_runtime_task(
        db=test_db,
        user=test_user,
        im_session=session,
        message="继续 runtime",
        message_context=handler.parse_message(_message("继续 runtime")),
        runtime_task=runtime_task,
    )

    assert handled is True
    assert handler.replies == []
    assert calls["callback"]["task_id"] == "runtime:device-1:codex-1"
    assert calls["emit_start"] == {
        "task_id": "runtime:device-1:codex-1",
        "subtask_id": 0,
    }
    assert "emit_status_prefix" not in calls
    assert calls["registered_emitter"] == {
        "task_id": "runtime:device-1:codex-1",
        "emitter": calls["created_emitter"],
    }
    assert calls["send"]["request"].address.local_task_id == "codex-1"


def _create_restricted_team(
    test_db: Session,
    test_user: User,
    *,
    allowed_model_name: str,
) -> Kind:
    bot = Kind(
        user_id=test_user.id,
        kind="Bot",
        name="restricted-bot",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "restricted-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "ghost", "namespace": "default"},
                "shellRef": {"name": "Chat", "namespace": "default"},
                "agent_config": {
                    "bind_model": allowed_model_name,
                    "allowed_models": [
                        {
                            "name": allowed_model_name,
                            "type": "public",
                            "namespace": "default",
                        }
                    ],
                },
            },
        },
    )
    test_db.add(bot)
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
            "spec": {
                "displayName": "Wegent Wework",
                "collaborationModel": "solo",
                "members": [
                    {
                        "botRef": {"name": "restricted-bot", "namespace": "default"},
                        "role": "worker",
                    }
                ],
            },
        },
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


@pytest.mark.asyncio
async def test_private_chat_mode_plain_text_fallthrough_keeps_user_fields_usable(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    expiring_channel_sessionlocal,
) -> None:
    handler = FakeChannelHandler(test_user)
    calls: dict[str, Any] = {}

    async def fake_route_private_im_session(
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        message_context: MessageContext,
    ) -> bool:
        calls["session_key"] = im_session.session_key
        return False

    async def fake_process_chat_message(
        user: User,
        message_context: MessageContext,
    ) -> None:
        calls["user_email"] = user.email
        calls["content"] = message_context.content

    monkeypatch.setattr(
        handler, "_route_private_im_session", fake_route_private_im_session
    )
    monkeypatch.setattr(handler, "_process_chat_message", fake_process_chat_message)

    handled = await handler.handle_message(_message("普通私聊消息"))

    test_db.expire_all()
    session = await _private_session(test_db, test_user)
    assert handled is True
    assert session is not None
    assert calls["session_key"] == session.session_key
    assert calls == {
        "session_key": session.session_key,
        "user_email": test_user.email,
        "content": "普通私聊消息",
    }
