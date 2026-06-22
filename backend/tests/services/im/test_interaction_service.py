# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession
from app.models.user import User
from app.services.channels.callback import ChannelType
from app.services.channels.handler import MessageContext
from app.services.im.interaction_service import im_interaction_service
from app.services.im.session_service import im_session_service

pytestmark = pytest.mark.asyncio


class FakeInteractionPort:
    channel_type = ChannelType.TELEGRAM
    channel_id = 44

    def __init__(self) -> None:
        self.replies: list[str] = []
        self.deleted_conversations: list[tuple[str, int]] = []
        self.bound_tasks: list[int | None] = []
        self.continued_tasks: list[tuple[int | None, str]] = []
        self.continued_runtime_tasks: list[dict[str, Any] | None] = []
        self.created_tasks: list[tuple[int | None, str]] = []

    async def send_text_reply(
        self,
        message_context: MessageContext,
        text: str,
    ) -> bool:
        self.replies.append(text)
        return True

    async def delete_conversation_task_id(
        self,
        conversation_id: str,
        user_id: int,
    ) -> None:
        self.deleted_conversations.append((conversation_id, user_id))

    async def execute_private_im_bind_task(
        self,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        task_id: int | None,
        message_context: MessageContext,
    ) -> None:
        self.bound_tasks.append(task_id)

    async def execute_private_im_continue_task(
        self,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        task_id: int | None,
        message: str,
        message_context: MessageContext,
        runtime_task: dict[str, Any] | None = None,
    ) -> None:
        self.continued_tasks.append((task_id, message))
        self.continued_runtime_tasks.append(runtime_task)

    async def execute_private_im_create_task(
        self,
        db: Session,
        user: User,
        im_session: IMPrivateSession,
        project_id: int | None,
        message: str,
        message_context: MessageContext,
    ) -> None:
        self.created_tasks.append((project_id, message))


def _context(
    content: str,
    *,
    images: list[dict[str, str]] | None = None,
    files: list[dict[str, Any]] | None = None,
) -> MessageContext:
    return MessageContext(
        content=content,
        sender_id="telegram-user",
        sender_name="Alice",
        conversation_id="telegram-chat",
        conversation_type="private",
        is_mention=False,
        raw_message={},
        extra_data={},
        images=images or [],
        files=files or [],
    )


async def _session(test_db: Session, test_user: User) -> IMPrivateSession:
    return await im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=44,
        conversation_id="telegram-chat",
        sender_id="telegram-user",
        display_name="Alice",
    )


def _stub_task_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.im.interaction_service.im_task_continuation_service.list_recent_wework_tasks",
        lambda db, user_id, limit=5: [],
    )
    monkeypatch.setattr(
        "app.services.im.interaction_service.im_task_continuation_service.list_wework_projects",
        lambda db, user_id, limit=8: [],
    )


@pytest.mark.asyncio
async def test_new_chat_choice_deletes_cached_chat_and_replies(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    _stub_task_lists(monkeypatch)

    first = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("/new"),
        port=port,
    )
    second = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("1"),
        port=port,
    )

    assert first is True
    assert second is True
    assert port.deleted_conversations == [("telegram-chat", test_user.id)]
    assert port.replies[-1] == "已开始新 Chat，请发送消息。"


@pytest.mark.asyncio
async def test_pending_switch_choice_binds_selected_task(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    monkeypatch.setattr(
        "app.services.im.interaction_service.im_task_continuation_service.list_recent_wework_tasks",
        lambda db, user_id, limit=5: [
            {"id": 101, "title": "修复登录"},
            {"id": 102, "title": "整理文档"},
        ],
    )
    monkeypatch.setattr(
        "app.services.im.interaction_service.im_task_continuation_service.list_wework_projects",
        lambda db, user_id, limit=8: [],
    )

    await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("/task"),
        port=port,
    )
    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("2"),
        port=port,
    )

    assert handled is True
    assert port.bound_tasks == [102]


@pytest.mark.asyncio
async def test_task_mode_text_continues_active_task(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    await im_session_service.bind_active_task(test_db, session=session, task_id=7001)
    _stub_task_lists(monkeypatch)

    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("继续处理"),
        port=port,
    )

    assert handled is True
    assert port.continued_tasks == [(7001, "继续处理")]


@pytest.mark.asyncio
async def test_task_mode_media_only_continues_active_task_with_empty_message(
    test_db: Session,
    test_user: User,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    await im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context(
            "",
            images=[{"mime_type": "image/png", "base64_data": "aGVsbG8="}],
        ),
        port=port,
    )

    assert handled is True
    assert port.continued_tasks == [(7001, "")]


@pytest.mark.asyncio
async def test_pending_task_creation_creates_selected_project_task(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    monkeypatch.setattr(
        "app.services.im.interaction_service.im_task_continuation_service.list_recent_wework_tasks",
        lambda db, user_id, limit=5: [],
    )
    monkeypatch.setattr(
        "app.services.im.interaction_service.im_task_continuation_service.list_wework_projects",
        lambda db, user_id, limit=8: [
            {"id": 201, "name": "Wegent Backend"},
            {"id": 202, "name": "Wegent Docs"},
        ],
    )

    await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("/task"),
        port=port,
    )
    await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("new"),
        port=port,
    )
    project_choice = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("2"),
        port=port,
    )
    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("创建新的任务需求"),
        port=port,
    )

    assert project_choice is True
    assert handled is True
    assert port.created_tasks == [(202, "创建新的任务需求")]


@pytest.mark.asyncio
async def test_none_action_sends_router_reply(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    _stub_task_lists(monkeypatch)

    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("/bind"),
        port=port,
    )

    assert handled is True
    assert port.replies == ["已绑定当前私聊会话。"]


@pytest.mark.asyncio
async def test_unhandled_plain_chat_message_falls_through(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    _stub_task_lists(monkeypatch)

    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("普通 Chat 消息"),
        port=port,
    )

    assert handled is False
    assert port.replies == []


@pytest.mark.asyncio
async def test_unhandled_router_action_falls_through(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = FakeInteractionPort()
    session = await _session(test_db, test_user)
    _stub_task_lists(monkeypatch)

    async def fake_route(**kwargs):
        return SimpleNamespace(handled=True, action="unknown")

    monkeypatch.setattr(
        "app.services.im.interaction_service.im_command_router.route",
        fake_route,
    )

    handled = await im_interaction_service.route_private_message(
        db=test_db,
        user=test_user,
        im_session=session,
        message_context=_context("/unknown-action"),
        port=port,
    )

    assert handled is False
