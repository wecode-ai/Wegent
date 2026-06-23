# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.channels.callback import ChannelType
from app.services.channels.weibo import handler as weibo_handler
from app.services.channels.weibo.handler import WeiboChannelHandler


class FakeSender:
    def __init__(self):
        self.send_text_message = AsyncMock(return_value=True)


def _event(text: str = "hello"):
    return {
        "type": "message",
        "payload": {
            "messageId": "mid-1",
            "fromUserId": "10001",
            "text": text,
            "timestamp": 1780000000000,
        },
    }


def test_parse_message_event():
    handler = WeiboChannelHandler(channel_id=7)

    context = handler.parse_message(_event("hello weibo"))

    assert context.content == "hello weibo"
    assert context.sender_id == "10001"
    assert context.sender_name is None
    assert context.conversation_id == "10001"
    assert context.conversation_type == "private"
    assert context.extra_data["weibo_user_id"] == "10001"
    assert context.extra_data["weibo_message_id"] == "mid-1"
    assert context.extra_data["weibo_timestamp"] == 1780000000000


def test_parse_control_event_returns_empty_context():
    handler = WeiboChannelHandler(channel_id=7)

    context = handler.parse_message({"type": "pong"})

    assert context.content == ""
    assert context.sender_id == ""
    assert context.conversation_id == ""
    assert context.extra_data["event_type"] == "pong"


@pytest.mark.asyncio
async def test_send_text_reply_uses_sender():
    sender = FakeSender()
    handler = WeiboChannelHandler(channel_id=7, sender=sender)
    context = handler.parse_message(_event())

    result = await handler.send_text_reply(context, "reply")

    assert result is True
    sender.send_text_message.assert_awaited_once_with(
        to_user_id="10001",
        text="reply",
    )


@pytest.mark.asyncio
async def test_send_text_reply_returns_false_without_sender():
    handler = WeiboChannelHandler(channel_id=7)
    context = handler.parse_message(_event())

    result = await handler.send_text_reply(context, "reply")

    assert result is False


@pytest.mark.asyncio
async def test_resolve_user_passes_weibo_fields_and_mapping_config(monkeypatch):
    calls = {}
    resolved_user = object()
    db = object()

    class FakeResolver:
        def __init__(self, db, user_mapping_mode=None, user_mapping_config=None):
            calls["db"] = db
            calls["user_mapping_mode"] = user_mapping_mode
            calls["user_mapping_config"] = user_mapping_config

        async def resolve_user(
            self,
            weibo_user_id: str,
            weibo_email: str | None = None,
        ):
            calls["weibo_user_id"] = weibo_user_id
            calls["weibo_email"] = weibo_email
            return resolved_user

    monkeypatch.setattr(weibo_handler, "WeiboUserResolver", FakeResolver)
    handler = WeiboChannelHandler(
        channel_id=7,
        get_user_mapping_config=lambda: {
            "mode": "email",
            "config": {"email_domain": "weibo.example"},
        },
    )

    result = await handler.resolve_user(db, handler.parse_message(_event()))

    assert result is resolved_user
    assert calls == {
        "db": db,
        "user_mapping_mode": "email",
        "user_mapping_config": {"email_domain": "weibo.example"},
        "weibo_user_id": "10001",
        "weibo_email": None,
    }


def test_create_callback_info_uses_weibo_channel_type():
    handler = WeiboChannelHandler(channel_id=7)

    info = handler.create_callback_info(handler.parse_message(_event()))

    assert info.channel_type == ChannelType.WEIBO
    assert info.channel_id == 7
    assert info.conversation_id == "10001"
    assert info.to_user_id == "10001"
