# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.channels.callback import ChannelType
from app.services.channels.discord import handler as discord_handler
from app.services.channels.discord.handler import DiscordChannelHandler


class FakePrivateChannel:
    async def send(self, content: str):
        return None


def _message(content: str = "hello"):
    author = SimpleNamespace(
        id=123456,
        name="alice",
        display_name="Alice",
        global_name="Alice Global",
        bot=False,
    )
    channel = FakePrivateChannel()
    channel.id = 987654
    channel.send = AsyncMock()
    return SimpleNamespace(
        content=content,
        author=author,
        channel=channel,
        id=111,
    )


def _message_without_author_id():
    message = _message()
    message.author = SimpleNamespace(
        name="alice",
        display_name="Alice",
        global_name="Alice Global",
        bot=False,
    )
    return message


def test_parse_dm_message():
    handler = DiscordChannelHandler(channel_id=7)

    context = handler.parse_message(_message("hello discord"))

    assert context.content == "hello discord"
    assert context.sender_id == "123456"
    assert context.sender_name == "Alice"
    assert context.conversation_id == "987654"
    assert context.conversation_type == "private"
    assert context.extra_data["discord_user_id"] == 123456
    assert context.extra_data["discord_username"] == "alice"
    assert context.extra_data["discord_global_name"] == "Alice Global"


def test_parse_dm_message_defaults_missing_author_id_to_zero():
    handler = DiscordChannelHandler(channel_id=7)

    context = handler.parse_message(_message_without_author_id())

    assert context.sender_id == "0"
    assert context.extra_data["discord_user_id"] == 0


@pytest.mark.asyncio
async def test_send_text_reply_uses_message_channel():
    handler = DiscordChannelHandler(channel_id=7)
    message = _message()
    context = handler.parse_message(message)

    result = await handler.send_text_reply(context, "reply")

    assert result is True
    message.channel.send.assert_awaited_once_with("reply")


@pytest.mark.asyncio
async def test_send_text_reply_returns_false_when_channel_send_fails():
    handler = DiscordChannelHandler(channel_id=7)
    message = _message()
    message.channel.send.side_effect = RuntimeError("discord unavailable")
    context = handler.parse_message(message)

    result = await handler.send_text_reply(context, "reply")

    assert result is False
    message.channel.send.assert_awaited_once_with("reply")


@pytest.mark.asyncio
async def test_resolve_user_passes_discord_fields_and_mapping_config(monkeypatch):
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
            discord_user_id: int,
            discord_username: str | None = None,
            discord_global_name: str | None = None,
        ):
            calls["discord_user_id"] = discord_user_id
            calls["discord_username"] = discord_username
            calls["discord_global_name"] = discord_global_name
            return resolved_user

    monkeypatch.setattr(discord_handler, "DiscordUserResolver", FakeResolver)
    handler = DiscordChannelHandler(
        channel_id=7,
        get_user_mapping_config=lambda: {
            "mode": "email",
            "config": {"email_domain": "example.com"},
        },
    )

    result = await handler.resolve_user(db, handler.parse_message(_message()))

    assert result is resolved_user
    assert calls == {
        "db": db,
        "user_mapping_mode": "email",
        "user_mapping_config": {"email_domain": "example.com"},
        "discord_user_id": 123456,
        "discord_username": "alice",
        "discord_global_name": "Alice Global",
    }


def test_create_callback_info_uses_discord_channel_type():
    handler = DiscordChannelHandler(channel_id=7)

    info = handler.create_callback_info(handler.parse_message(_message()))

    assert info.channel_type == ChannelType.DISCORD
    assert info.channel_id == 7
    assert info.conversation_id == "987654"
