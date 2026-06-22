# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from types import SimpleNamespace

import discord
import pytest

from app.services.channels.discord.service import DiscordChannelProvider
from app.services.channels.manager import ChannelManager


def _channel(config: dict):
    return SimpleNamespace(
        id=77,
        name="discord-main",
        channel_type="discord",
        is_enabled=True,
        config=config,
        default_team_id=100,
        default_model_name="",
    )


@pytest.mark.asyncio
async def test_discord_provider_requires_bot_token():
    provider = DiscordChannelProvider(_channel({}))

    started = await provider.start()

    assert started is False
    assert "missing bot_token" in provider.last_error


@pytest.mark.asyncio
async def test_discord_provider_routes_only_user_dm_messages(monkeypatch):
    handled_messages = []

    class FakePrivateChannel:
        pass

    class FakeHandler:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def handle_message(self, message):
            handled_messages.append(message)

    class FakeClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.events = {}
            self.started_token = None
            self.closed = False
            self._started = asyncio.Event()

        def event(self, callback):
            self.events[callback.__name__] = callback
            return callback

        async def start(self, token):
            self.started_token = token
            await self.events["on_ready"]()
            self._started.set()
            await asyncio.Future()

        async def close(self):
            self.closed = True

    from app.services.channels.discord import service as discord_service

    fake_client = FakeClient()
    monkeypatch.setattr(discord.abc, "PrivateChannel", FakePrivateChannel)
    monkeypatch.setattr(discord_service, "DiscordChannelHandler", FakeHandler)

    provider = DiscordChannelProvider(_channel({"botToken": "token-1"}))
    monkeypatch.setattr(provider, "_create_client", lambda: fake_client)

    started = await provider.start()
    await fake_client._started.wait()

    assert started is True
    assert fake_client.started_token == "token-1"

    user_dm = SimpleNamespace(
        author=SimpleNamespace(id=2, bot=False),
        channel=FakePrivateChannel(),
    )
    own_message = SimpleNamespace(author=fake_client.user, channel=FakePrivateChannel())
    bot_message = SimpleNamespace(
        author=SimpleNamespace(id=3, bot=True),
        channel=FakePrivateChannel(),
    )
    guild_message = SimpleNamespace(
        author=SimpleNamespace(id=4, bot=False),
        channel=object(),
    )

    await fake_client.events["on_message"](own_message)
    await fake_client.events["on_message"](bot_message)
    await fake_client.events["on_message"](guild_message)
    await fake_client.events["on_message"](user_dm)

    assert handled_messages == [user_dm]

    await provider.stop()

    assert fake_client.closed is True
    assert provider.is_running is False


@pytest.mark.asyncio
async def test_discord_provider_fails_fast_on_start_failure(monkeypatch):
    class FailingClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.started = asyncio.Event()
            self.closed = False

        def event(self, callback):
            return callback

        async def start(self, token):
            self.started.set()
            raise RuntimeError(f"boom for {token}")

        async def close(self):
            self.closed = True

    from app.services.channels.discord import service as discord_service

    monkeypatch.setattr(
        discord_service, "DiscordChannelHandler", lambda **kwargs: object()
    )
    fake_client = FailingClient()
    provider = DiscordChannelProvider(_channel({"bot_token": "token-2"}))
    monkeypatch.setattr(provider, "_create_client", lambda: fake_client)

    assert await provider.start() is False
    await fake_client.started.wait()

    assert provider.is_running is False
    assert provider.last_error == "Discord client stopped: boom for token-2"


def test_channel_manager_registers_discord_provider():
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()

    assert "discord" in manager.get_supported_channel_types()


@pytest.mark.asyncio
async def test_channel_manager_restarts_stale_provider():
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()
    providers = []

    class FakeProvider:
        def __init__(self, channel):
            self.channel_name = channel.name
            self.channel_type = channel.channel_type
            self._is_running = False
            self.stop_calls = 0

        @property
        def is_running(self):
            return self._is_running

        async def start(self):
            self._is_running = True
            return True

        async def stop(self):
            self.stop_calls += 1
            self._is_running = False

        def get_status(self):
            return {"is_connected": self._is_running}

    def create_provider(channel):
        provider = FakeProvider(channel)
        providers.append(provider)
        return provider

    channel = _channel({"bot_token": "token"})
    channel.channel_type = "fake"
    manager.register_provider_factory("fake", create_provider)

    assert await manager.start_channel(channel) is True
    providers[0]._is_running = False

    assert await manager.start_channel(channel) is True

    assert len(providers) == 2
    assert providers[0].stop_calls == 1
    assert manager.get_channel(channel.id) is providers[1]


@pytest.mark.asyncio
async def test_channel_manager_serializes_concurrent_start_for_same_channel():
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()
    providers = []
    release_start = asyncio.Event()

    class SlowProvider:
        def __init__(self, channel):
            self.channel_name = channel.name
            self.channel_type = channel.channel_type
            self._is_running = False

        @property
        def is_running(self):
            return self._is_running

        async def start(self):
            await release_start.wait()
            self._is_running = True
            return True

        async def stop(self):
            self._is_running = False

        def get_status(self):
            return {"is_connected": self._is_running}

    def create_provider(channel):
        provider = SlowProvider(channel)
        providers.append(provider)
        return provider

    channel = _channel({"bot_token": "token"})
    channel.channel_type = "slow"
    manager.register_provider_factory("slow", create_provider)

    first_start = asyncio.create_task(manager.start_channel(channel))
    second_start = asyncio.create_task(manager.start_channel(channel))

    while not providers:
        await asyncio.sleep(0)
    release_start.set()

    assert await asyncio.gather(first_start, second_start) == [True, True]
    assert len(providers) == 1
    assert manager.get_channel(channel.id) is providers[0]


@pytest.mark.asyncio
async def test_channel_manager_hides_discord_provider_after_background_failure(
    monkeypatch,
):
    ChannelManager.reset_instance()
    manager = ChannelManager.get_instance()

    class FailingClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.started = asyncio.Event()

        def event(self, callback):
            return callback

        async def start(self, token):
            self.started.set()
            raise RuntimeError(f"boom for {token}")

        async def close(self):
            pass

    from app.services.channels.discord import service as discord_service

    monkeypatch.setattr(
        discord_service, "DiscordChannelHandler", lambda **kwargs: object()
    )
    fake_client = FailingClient()
    monkeypatch.setattr(
        DiscordChannelProvider,
        "_create_client",
        lambda self: fake_client,
    )

    channel = _channel({"bot_token": "token-3"})

    assert await manager.start_channel(channel) is False
    assert manager.get_channel(channel.id) is None

    await fake_client.started.wait()
    assert manager.get_channel(channel.id) is None
    assert manager.get_status(channel.id) is None
    assert manager.get_all_statuses() == []
