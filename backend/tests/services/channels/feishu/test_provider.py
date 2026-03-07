# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.channels.feishu.service import FeishuChannelProvider


@pytest.mark.asyncio
async def test_start_requires_configuration():
    channel = SimpleNamespace(
        id=1,
        name="feishu",
        channel_type="feishu",
        is_enabled=True,
        config={},
        default_team_id=1,
        default_model_name="",
    )

    provider = FeishuChannelProvider(channel)
    started = await provider.start()

    assert started is False
    assert provider.is_running is False


@pytest.mark.asyncio
async def test_handle_event_url_verification():
    channel = SimpleNamespace(
        id=2,
        name="feishu",
        channel_type="feishu",
        is_enabled=True,
        config={"app_id": "id", "app_secret": "secret"},
        default_team_id=1,
        default_model_name="",
    )

    provider = FeishuChannelProvider(channel)
    assert await provider.start() is True

    result = await provider.handle_event(
        {"type": "url_verification", "challenge": "abc123"}
    )

    assert result == {"challenge": "abc123"}


@pytest.mark.asyncio
async def test_handle_event_text_message_calls_handler(monkeypatch):
    channel = SimpleNamespace(
        id=3,
        name="feishu",
        channel_type="feishu",
        is_enabled=True,
        config={
            "app_id": "id",
            "app_secret": "secret",
            "verification_token": "token-1",
        },
        default_team_id=1,
        default_model_name="",
    )

    provider = FeishuChannelProvider(channel)
    assert await provider.start() is True

    mocked_handle = AsyncMock(return_value=True)
    provider._handler.handle_message = mocked_handle

    monkeypatch.setattr(
        "app.services.channels.feishu.service.cache_manager.get",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "app.services.channels.feishu.service.cache_manager.set",
        AsyncMock(return_value=True),
    )

    payload = {
        "token": "token-1",
        "header": {
            "event_type": "im.message.receive_v1",
            "event_id": "evt-1",
        },
        "event": {
            "message": {
                "message_type": "text",
                "chat_id": "oc_123",
                "chat_type": "p2p",
                "content": '{"text":"hello"}',
            },
            "sender": {
                "sender_id": {
                    "open_id": "ou_1",
                    "user_id": "u_1",
                }
            },
            "mentions": [],
        },
    }

    result = await provider.handle_event(payload)

    assert result == {"ok": True}
    mocked_handle.assert_awaited_once()
