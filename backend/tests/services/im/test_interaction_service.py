# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.im_session import IMPrivateSession, IMSessionMode
from app.services.im.interaction_service import GUIDANCE, im_interaction_service
from app.services.im.session_service import im_session_service

pytestmark = pytest.mark.asyncio


def fixture(content):
    return (
        IMPrivateSession("s", 7, "telegram", 1, "chat", "sender"),
        SimpleNamespace(
            content=content, conversation_id="chat", images=[], files=[], extra_data={}
        ),
        SimpleNamespace(
            send_text_reply=AsyncMock(), delete_conversation_task_id=AsyncMock()
        ),
    )


@pytest.mark.parametrize("content", ["hello", "", "1"])
async def test_stand_in_mode_routes_text_media_and_old_numeric_choices(
    monkeypatch, content
):
    session, context, port = fixture(content)
    context.images = [{}]
    context.extra_data = {"reply_to_message_id": "old-task-notification"}
    await im_session_service.set_mode(session, IMSessionMode.STAND_IN)
    send = AsyncMock()
    monkeypatch.setattr(
        "app.services.im.interaction_service.send_stand_in_message", send
    )
    db, user = Mock(), SimpleNamespace(id=7)
    assert await im_interaction_service.route_private_message(
        db=db, user=user, im_session=session, message_context=context, port=port
    )
    send.assert_awaited_once_with(db, user, session, context, port)


@pytest.mark.parametrize(
    "content",
    [
        "hello",
        "/new",
        "/use cloud",
        "/devices",
        "/models",
        "/agents",
        "/help",
        "/status",
    ],
)
async def test_default_chat_preserves_the_existing_wegent_flow(monkeypatch, content):
    session, context, port = fixture(content)
    send = AsyncMock()
    monkeypatch.setattr(
        "app.services.im.interaction_service.send_stand_in_message", send
    )
    assert (
        await im_interaction_service.route_private_message(
            db=Mock(),
            user=SimpleNamespace(id=7),
            im_session=session,
            message_context=context,
            port=port,
        )
        is False
    )
    assert await im_session_service.get_mode(session) == IMSessionMode.CHAT
    send.assert_not_awaited()
    port.send_text_reply.assert_not_awaited()


@pytest.mark.parametrize(
    "command",
    ["/standin", "/stand-in", "/分身", "/mode standin", "/mode stand_in", "/mode 分身"],
)
async def test_explicit_command_enters_stand_in_mode(command):
    session, context, port = fixture(command)
    assert await im_interaction_service.route_private_message(
        db=Mock(),
        user=SimpleNamespace(id=7),
        im_session=session,
        message_context=context,
        port=port,
    )
    assert await im_session_service.get_mode(session) == IMSessionMode.STAND_IN
    assert "分身模式" in port.send_text_reply.await_args.args[1]


async def test_chat_command_leaves_stand_in_without_changing_its_identity(monkeypatch):
    from app.services.channels.device_selection import device_selection_manager

    session, context, port = fixture("/chat")
    await im_session_service.set_mode(session, IMSessionMode.STAND_IN)
    selection = AsyncMock()
    monkeypatch.setattr(device_selection_manager, "set_chat_mode", selection)
    assert await im_interaction_service.route_private_message(
        db=Mock(),
        user=SimpleNamespace(id=7),
        im_session=session,
        message_context=context,
        port=port,
    )
    assert await im_session_service.get_mode(session) == IMSessionMode.CHAT
    selection.assert_awaited_once_with(7)
    port.delete_conversation_task_id.assert_awaited_once_with("chat", 7)


@pytest.mark.parametrize("command", ["/task", "/switch", "/mode task", "/cancel"])
async def test_retired_task_commands_cannot_create_or_select_a_task(command):
    session, context, port = fixture(command)
    await im_interaction_service.route_private_message(
        db=Mock(),
        user=SimpleNamespace(id=7),
        im_session=session,
        message_context=context,
        port=port,
    )
    assert await im_session_service.get_mode(session) == IMSessionMode.CHAT
    assert (
        "/standin" in port.send_text_reply.await_args.args[1]
        or "/mode standin" in port.send_text_reply.await_args.args[1]
    )


async def test_stand_in_mode_does_not_change_wegent_model_or_device_commands():
    session, context, port = fixture("/models")
    await im_session_service.set_mode(session, IMSessionMode.STAND_IN)
    await im_interaction_service.route_private_message(
        db=Mock(),
        user=SimpleNamespace(id=7),
        im_session=session,
        message_context=context,
        port=port,
    )
    assert port.send_text_reply.await_args.args[1] == GUIDANCE


async def test_notification_preference_remains_independent(fake_im_session_cache):
    session, _, _ = fixture("")
    assert "开启" in await im_interaction_service._notification_command(
        None, session, "on"
    )
    assert "已开启" in await im_interaction_service._notification_command(
        None, session, "status"
    )
    assert "关闭" in await im_interaction_service._notification_command(
        None, session, "off"
    )
