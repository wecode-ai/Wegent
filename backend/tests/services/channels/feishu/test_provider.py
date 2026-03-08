# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
from types import ModuleType, SimpleNamespace

import pytest

from app.services.channels.feishu.service import FeishuChannelProvider


class _FakeWsClient:
    def __init__(self, app_id, app_secret, event_handler):
        self.app_id = app_id
        self.app_secret = app_secret
        self.event_handler = event_handler

    def start(self):
        return None


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
async def test_start_with_long_connection_sdk(monkeypatch):
    channel = SimpleNamespace(
        id=2,
        name="feishu",
        channel_type="feishu",
        is_enabled=True,
        config={"app_id": "id", "app_secret": "secret"},
        default_team_id=1,
        default_model_name="",
    )

    ws_client_module = ModuleType("lark_oapi.ws.client")
    ws_client_module.Client = _FakeWsClient
    ws_module = ModuleType("lark_oapi.ws")
    ws_module.client = ws_client_module
    event_dispatcher_module = ModuleType("lark_oapi.event.dispatcher_handler")

    class _FakeBuilder:
        def register_p2_im_message_receive_v1(self, _handler):
            return self

        def build(self):
            return object()

    class _FakeEventDispatcherHandler:
        @staticmethod
        def builder(_encrypt_key, _verification_token):
            return _FakeBuilder()

    event_dispatcher_module.EventDispatcherHandler = _FakeEventDispatcherHandler
    event_module = ModuleType("lark_oapi.event")
    event_module.dispatcher_handler = event_dispatcher_module
    root_module = ModuleType("lark_oapi")
    root_module.ws = ws_module
    root_module.event = event_module

    monkeypatch.setitem(sys.modules, "lark_oapi", root_module)
    monkeypatch.setitem(sys.modules, "lark_oapi.ws", ws_module)
    monkeypatch.setitem(sys.modules, "lark_oapi.ws.client", ws_client_module)
    monkeypatch.setitem(sys.modules, "lark_oapi.event", event_module)
    monkeypatch.setitem(
        sys.modules,
        "lark_oapi.event.dispatcher_handler",
        event_dispatcher_module,
    )

    provider = FeishuChannelProvider(channel)
    started = await provider.start()

    assert started is True
    assert provider.is_running is True

    await provider.stop()


@pytest.mark.asyncio
async def test_handle_long_connection_event_dedup(monkeypatch):
    channel = SimpleNamespace(
        id=3,
        name="feishu",
        channel_type="feishu",
        is_enabled=True,
        config={"app_id": "id", "app_secret": "secret"},
        default_team_id=1,
        default_model_name="",
    )
    provider = FeishuChannelProvider(channel)

    called = {"value": False}

    class _MockHandler:
        async def handle_message(self, _payload):
            called["value"] = True
            return True

    provider._handler = _MockHandler()

    async def _mock_get(_key):
        return "1"

    async def _mock_set(_key, _value, ex=None):
        return True

    monkeypatch.setattr(
        "app.services.channels.feishu.service.cache_manager.get", _mock_get
    )
    monkeypatch.setattr(
        "app.services.channels.feishu.service.cache_manager.set", _mock_set
    )

    event = SimpleNamespace(
        header=SimpleNamespace(event_id="evt-1", event_type="im.message.receive_v1"),
        event=SimpleNamespace(
            message=SimpleNamespace(message_type="text", mentions=[]),
            sender=SimpleNamespace(sender_id=SimpleNamespace()),
        ),
    )

    await provider._handle_long_connection_event(event)

    assert called["value"] is False
