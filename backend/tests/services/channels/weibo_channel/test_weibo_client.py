# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.channels.weibo.client import (
    DEFAULT_TOKEN_ENDPOINT,
    DEFAULT_WS_ENDPOINT,
    RETRYABLE_TOKEN_STATUS_CODES,
    WeiboClientConfig,
    WeiboTokenFetchError,
    WeiboWebSocketClient,
)


class FakeCache:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, expire=None):
        self.values[key] = value
        return True

    async def delete(self, key):
        self.values.pop(key, None)
        return True


class FakeResponse:
    def __init__(self, status=200, payload=None):
        self.status = status
        self.payload = payload or {
            "data": {"token": "tok-1", "expire_in": 3600, "uid": 9}
        }

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return self.payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.posts = []
        self.ws_urls = []
        self.ws = None

    def post(self, url, json):
        self.posts.append((url, json))
        return self.responses.pop(0)

    async def ws_connect(self, url):
        self.ws_urls.append(url)
        self.ws = SimpleNamespace(
            closed=False,
            send_str=AsyncMock(),
            close=AsyncMock(),
        )
        return self.ws

    async def close(self):
        return None


class FakeReceiveWebSocket:
    def __init__(self, messages):
        self.messages = list(messages)
        self.closed = False
        self.close = AsyncMock()
        self.send_str = AsyncMock()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.messages:
            raise StopAsyncIteration
        return SimpleNamespace(data=self.messages.pop(0))


def _config():
    return WeiboClientConfig(
        channel_id=7,
        app_id="app-1",
        app_secret="secret-1",
        ws_endpoint=DEFAULT_WS_ENDPOINT,
        token_endpoint=DEFAULT_TOKEN_ENDPOINT,
    )


@pytest.mark.asyncio
async def test_fetch_token_posts_app_credentials_and_caches_token():
    cache = FakeCache()
    session = FakeSession([FakeResponse()])
    client = WeiboWebSocketClient(
        config=_config(),
        cache=cache,
        session_factory=lambda: session,
    )

    token = await client.get_valid_token()
    cached = await client.get_valid_token()

    assert token == "tok-1"
    assert cached == "tok-1"
    assert session.posts == [
        (
            DEFAULT_TOKEN_ENDPOINT,
            {"app_id": "app-1", "app_secret": "secret-1"},
        )
    ]


@pytest.mark.asyncio
async def test_fetch_token_retries_retryable_status_once(monkeypatch):
    sleeps = []
    cache = FakeCache()
    session = FakeSession([FakeResponse(status=500), FakeResponse()])
    client = WeiboWebSocketClient(
        config=_config(),
        cache=cache,
        session_factory=lambda: session,
    )
    monkeypatch.setattr(
        "app.services.channels.weibo.client.asyncio.sleep",
        AsyncMock(side_effect=lambda delay: sleeps.append(delay)),
    )

    token = await client.get_valid_token()

    assert token == "tok-1"
    assert 500 in RETRYABLE_TOKEN_STATUS_CODES
    assert len(session.posts) == 2
    assert sleeps == [1.0]


@pytest.mark.asyncio
async def test_fetch_token_raises_for_missing_token():
    cache = FakeCache()
    session = FakeSession([FakeResponse(payload={"data": {"expire_in": 3600}})])
    client = WeiboWebSocketClient(
        config=_config(),
        cache=cache,
        session_factory=lambda: session,
    )

    with pytest.raises(WeiboTokenFetchError, match="missing token"):
        await client.get_valid_token()


@pytest.mark.asyncio
async def test_connect_uses_token_in_websocket_query():
    cache = FakeCache()
    session = FakeSession([FakeResponse()])
    client = WeiboWebSocketClient(
        config=_config(),
        cache=cache,
        session_factory=lambda: session,
    )

    await client.connect_once()

    assert len(session.ws_urls) == 1
    assert "app_id=app-1" in session.ws_urls[0]
    assert "token=tok-1" in session.ws_urls[0]
    assert "version=" in session.ws_urls[0]


@pytest.mark.asyncio
async def test_send_ping_writes_weibo_ping_frame():
    cache = FakeCache()
    session = FakeSession([FakeResponse()])
    client = WeiboWebSocketClient(
        config=_config(),
        cache=cache,
        session_factory=lambda: session,
    )

    await client.connect_once()
    await client.send_ping()

    session.ws.send_str.assert_awaited_once_with('{"type": "ping"}')


def test_handle_ws_text_marks_pong_timestamp():
    cache = FakeCache()
    session = FakeSession([FakeResponse()])
    client = WeiboWebSocketClient(
        config=_config(),
        cache=cache,
        session_factory=lambda: session,
    )

    assert client.handle_ws_text("pong") is None
    assert client._last_pong_at > 0


@pytest.mark.asyncio
async def test_receive_loop_routes_json_message_to_callback():
    received = []
    client = WeiboWebSocketClient(
        config=_config(),
        cache=FakeCache(),
        on_message=AsyncMock(side_effect=lambda event: received.append(event)),
    )
    client._ws = FakeReceiveWebSocket(
        [
            "pong",
            '{"type":"message","payload":{"text":"hello"}}',
            "not-json",
        ]
    )

    await client._receive_loop()

    assert received == [{"type": "message", "payload": {"text": "hello"}}]


@pytest.mark.asyncio
async def test_start_creates_background_tasks_and_close_cancels_them():
    client = WeiboWebSocketClient(config=_config(), cache=FakeCache())

    async def wait_forever():
        await asyncio.sleep(3600)

    client._run_forever = wait_forever
    client._heartbeat_loop = wait_forever

    await client.start()

    assert client._running is True
    assert client._task is not None
    assert client._heartbeat_task is not None

    await client.close()

    assert client._running is False
    assert client._task is None
    assert client._heartbeat_task is None
