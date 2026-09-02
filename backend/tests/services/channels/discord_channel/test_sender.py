# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import threading
from typing import Any

import pytest

from app.services.channels.discord.sender import DiscordBotSender


class FakeResponse:
    def __init__(
        self,
        payload: dict[str, Any],
        decoder_threads: list[int] | None = None,
    ):
        self._payload = payload
        self._decoder_threads = decoder_threads
        self.content = b"{}"

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        if self._decoder_threads is not None:
            self._decoder_threads.append(threading.get_ident())
        return self._payload


@pytest.mark.asyncio
async def test_send_text_message_posts_discord_dm(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict[str, Any]] = []
    decoder_threads: list[int] = []
    loop_thread = threading.get_ident()

    class FakeClient:
        def __init__(self, timeout: float):
            calls.append({"timeout": timeout})

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, content: bytes, headers: dict[str, str]):
            calls.append({"url": url, "content": content, "headers": headers})
            if url.endswith("/users/@me/channels"):
                return FakeResponse({"id": "dm-channel"}, decoder_threads)
            return FakeResponse({"id": "message-id"}, decoder_threads)

    monkeypatch.setattr(
        "app.services.channels.discord.sender.httpx.AsyncClient", FakeClient
    )

    result = await DiscordBotSender("discord-token").send_text_message(
        user_id="123456",
        text="hello",
    )

    assert result["success"] is True
    assert calls[1]["url"] == "https://discord.com/api/v10/users/@me/channels"
    assert calls[1]["content"] == b'{"recipient_id":"123456"}'
    assert calls[2]["url"] == "https://discord.com/api/v10/channels/dm-channel/messages"
    assert calls[2]["content"] == b'{"content":"hello"}'
    assert calls[2]["headers"]["Authorization"] == "Bot discord-token"
    assert len(decoder_threads) == 2
    assert all(thread_id != loop_thread for thread_id in decoder_threads)


@pytest.mark.asyncio
async def test_send_text_message_truncates_content_over_discord_limit(
    monkeypatch: pytest.MonkeyPatch,
):
    calls: list[dict[str, Any]] = []

    class FakeClient:
        def __init__(self, timeout: float):
            calls.append({"timeout": timeout})

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, content: bytes, headers: dict[str, str]):
            calls.append({"url": url, "content": content, "headers": headers})
            if url.endswith("/users/@me/channels"):
                return FakeResponse({"id": "dm-channel"})
            return FakeResponse({"id": "message-id"})

    monkeypatch.setattr(
        "app.services.channels.discord.sender.httpx.AsyncClient", FakeClient
    )

    result = await DiscordBotSender("discord-token").send_text_message(
        user_id="123456",
        text="a" * 2001,
    )

    expected_content = f'{"a" * 1997}...'
    assert result["success"] is True
    assert len(expected_content) == 2000
    assert calls[2]["content"] == (
        f'{{"content":"{expected_content}"}}'.encode("utf-8")
    )
