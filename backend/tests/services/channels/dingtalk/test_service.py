# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import dingtalk_stream
import pytest

from app.services.channels.dingtalk.selection_cards import (
    DingTalkSelectionCardCallbackHandler,
)
from app.services.channels.dingtalk.service import DingTalkChannelProvider


@pytest.mark.asyncio
async def test_provider_registers_stream_card_callback_when_configured(monkeypatch):
    class FakeClient:
        def __init__(self, credential):
            self.credential = credential
            self.handlers = {}

        def register_callback_handler(self, topic, handler):
            self.handlers[topic] = handler

        async def start(self):
            return None

    monkeypatch.setattr(
        dingtalk_stream,
        "Credential",
        lambda client_id, client_secret: SimpleNamespace(
            client_id=client_id,
            client_secret=client_secret,
        ),
    )
    monkeypatch.setattr(dingtalk_stream, "DingTalkStreamClient", FakeClient)
    channel = SimpleNamespace(
        id=77,
        name="dingtalk-main",
        channel_type="dingtalk",
        is_enabled=True,
        default_team_id=10,
        config={
            "client_id": "ding-app-key",
            "client_secret": "ding-app-secret",
            "conversation_card_template_id": "answer.schema",
            "interaction_card_template_id": "settings.schema",
        },
    )
    provider = DingTalkChannelProvider(channel)

    started = await provider.start()

    assert started is True
    assert dingtalk_stream.chatbot.ChatbotMessage.TOPIC in provider._client.handlers
    callback = provider._client.handlers[
        dingtalk_stream.CallbackHandler.TOPIC_CARD_CALLBACK
    ]
    assert isinstance(callback, DingTalkSelectionCardCallbackHandler)
    await provider.stop()
