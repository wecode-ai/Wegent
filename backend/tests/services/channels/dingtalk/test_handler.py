# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace

import pytest

import app.services.channels.dingtalk.handler as handler_module
from app.services.channels.dingtalk.handler import (
    DingTalkChannelHandler,
    WegentChatbotHandler,
)
from app.services.channels.dingtalk.user_mapping import MappedUserInfo
from app.services.channels.handler import MessageContext


def _message() -> SimpleNamespace:
    return SimpleNamespace(
        text=SimpleNamespace(content="continue runtime"),
        message_type="text",
        sender_id="staff-a",
        sender_nick="Alice",
        sender_staff_id="staff-a",
        sender_corp_id="corp-a",
        chatbot_user_id="bot-a",
        at_users=[],
        conversation_id="conv-private",
        conversation_type="1",
        conversation_title=None,
        is_in_at_list=False,
        get_image_list=lambda: [],
    )


def test_parse_message_preserves_dingtalk_message_id() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="continue runtime"),
        message_type="text",
        sender_id="staff-a",
        sender_nick="Alice",
        sender_staff_id="staff-a",
        sender_corp_id="corp-a",
        chatbot_user_id="bot-a",
        at_users=[],
        conversation_id="conv-private",
        conversation_type="1",
        is_in_at_list=False,
        _wegent_callback_data={"msgId": "dingtalk-message-1"},
    )

    context = handler.parse_message(message)

    assert context.content == "continue runtime"
    assert context.extra_data["message_id"] == "dingtalk-message-1"
    assert context.extra_data["callback_data"]["msgId"] == "dingtalk-message-1"
    assert context.proactive_recipient_id == "staff-a"


@pytest.mark.asyncio
async def test_binding_sync_phase_keeps_loop_responsive_and_closes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    session_thread_ids: list[int] = []
    main_thread_id = threading.get_ident()

    class FakeSession:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    session = FakeSession()

    async def map_external_user(**_: object) -> MappedUserInfo:
        return MappedUserInfo(user_name="staff-a")

    def resolve_user_from_mapping(self: object, **_: object) -> SimpleNamespace:
        session_thread_ids.append(threading.get_ident())
        assert not session.closed
        return SimpleNamespace(id=41)

    def update_binding(*, db: object, **_: object) -> None:
        assert db is session
        session_thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2)
        assert not session.closed

    def check_binding(*, db: object, **_: object) -> dict[str, bool]:
        assert db is session
        session_thread_ids.append(threading.get_ident())
        return {"matched": True, "completed": True}

    monkeypatch.setattr(handler_module, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        handler_module.DingTalkUserResolver,
        "map_external_user",
        map_external_user,
    )
    monkeypatch.setattr(
        handler_module.DingTalkUserResolver,
        "resolve_user_from_mapping",
        resolve_user_from_mapping,
    )
    monkeypatch.setattr(
        handler_module.subscription_notification_service,
        "update_user_im_binding",
        update_binding,
    )
    monkeypatch.setattr(
        handler_module.subscription_notification_service,
        "handle_dingtalk_binding_from_message",
        check_binding,
    )

    handler = WegentChatbotHandler(
        channel_id=77,
        get_user_mapping_config=lambda: {"mode": "staff_id", "config": {}},
    )
    message = _message()
    context = handler._channel_handler.parse_message(message)

    binding_task = asyncio.create_task(
        handler._update_subscription_binding_nonblocking(context, message)
    )
    while not entered.is_set():
        await asyncio.sleep(0)

    ticks = 0
    for _ in range(10):
        await asyncio.sleep(0)
        ticks += 1

    assert ticks == 10
    assert not session.closed
    release.set()
    await binding_task

    assert session.closed
    assert session_thread_ids
    assert all(thread_id != main_thread_id for thread_id in session_thread_ids)


@pytest.mark.asyncio
async def test_reply_text_uses_sdk_worker_and_preserves_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    calls: list[tuple[str, object]] = []

    class FakeMessage:
        pass

    raw_message = FakeMessage()

    def reply_text(text: str, message: object) -> None:
        calls.append((text, message))
        entered.set()
        assert release.wait(timeout=2)

    monkeypatch.setattr(handler_module, "ChatbotMessage", FakeMessage)
    handler = DingTalkChannelHandler(channel_id=77)
    handler.set_chatbot_handler(SimpleNamespace(reply_text=reply_text))
    context = MessageContext(
        content="question",
        sender_id="staff-a",
        sender_name="Alice",
        conversation_id="conv-private",
        conversation_type="private",
        is_mention=False,
        raw_message=raw_message,
        extra_data={},
    )

    reply_task = asyncio.create_task(handler.send_text_reply(context, "answer"))
    while not entered.is_set():
        await asyncio.sleep(0)

    ticks = 0
    for _ in range(10):
        await asyncio.sleep(0)
        ticks += 1

    assert ticks == 10
    release.set()
    assert await reply_task is True
    assert calls == [("answer", raw_message)]


@pytest.mark.asyncio
async def test_process_keeps_binding_before_same_message_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = WegentChatbotHandler(channel_id=77)
    message = _message()
    events: list[tuple[str, object]] = []

    async def update_binding(context: MessageContext, incoming: object) -> None:
        events.append(("binding", incoming))
        assert context.raw_message is message

    async def handle_message(incoming: object) -> bool:
        events.append(("handle", incoming))
        return True

    monkeypatch.setattr(
        handler,
        "_update_subscription_binding_nonblocking",
        update_binding,
    )
    monkeypatch.setattr(
        handler._channel_handler,
        "handle_message",
        handle_message,
    )

    assert await handler._process_with_channel_handler(message, {"msgId": "m-1"})
    assert events == [("binding", message), ("handle", message)]
