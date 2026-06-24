# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.channels.callback import ChannelType
from app.services.channels.manager import ChannelManager
from app.services.channels.weibo.service import WeiboChannelProvider


class FakeWeiboChannel:
    id = 7
    name = "weibo-main"
    channel_type = "weibo"
    is_enabled = True
    default_team_id = 11
    default_model_name = "gpt-test"

    def __init__(self, config):
        self.config = config


def test_channel_type_includes_weibo():
    assert ChannelType.WEIBO.value == "weibo"


def test_channel_manager_registers_weibo_provider():
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()

    assert "weibo" in manager.get_supported_channel_types()


@pytest.mark.asyncio
async def test_weibo_provider_reports_missing_required_config():
    provider = WeiboChannelProvider(FakeWeiboChannel({"app_id": "app-1"}))

    assert await provider.start() is False
    assert provider.is_running is False
    assert "missing app_id or app_secret" in provider.last_error


@pytest.mark.asyncio
async def test_weibo_provider_starts_client_and_routes_message(monkeypatch):
    handled = []

    class FakeClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.started = False
            self.closed = False

        async def start(self):
            self.started = True

        async def close(self):
            self.closed = True

    class FakeHandler:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def handle_message(self, event):
            handled.append(event)

    from app.services.channels.weibo import service as weibo_service

    monkeypatch.setattr(weibo_service, "WeiboWebSocketClient", FakeClient)
    monkeypatch.setattr(weibo_service, "WeiboChannelHandler", FakeHandler)

    provider = WeiboChannelProvider(
        FakeWeiboChannel({"app_id": "app-1", "app_secret": "secret-1"})
    )

    assert await provider.start() is True
    assert provider.is_running is True
    assert provider.sender is not None

    await provider._handle_weibo_event({"type": "message"})

    assert handled == [{"type": "message"}]

    client = provider._client
    await provider.stop()

    assert provider.is_running is False
    assert client.closed is True
