# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

import pytest

from app.services.channels.discord.sender import DiscordBotSender


class FakeResponse:
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


@pytest.mark.asyncio
async def test_send_text_message_posts_discord_dm(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict[str, Any]] = []

    class FakeClient:
        def __init__(self, timeout: float):
            calls.append({"timeout": timeout})

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, json: dict[str, Any], headers: dict[str, str]):
            calls.append({"url": url, "json": json, "headers": headers})
            if url.endswith("/users/@me/channels"):
                return FakeResponse({"id": "dm-channel"})
            return FakeResponse({"id": "message-id"})

    monkeypatch.setattr(
        "app.services.channels.discord.sender.httpx.AsyncClient", FakeClient
    )

    result = await DiscordBotSender("discord-token").send_text_message(
        user_id="123456",
        text="hello",
    )

    assert result["success"] is True
    assert calls[1]["url"] == "https://discord.com/api/v10/users/@me/channels"
    assert calls[1]["json"] == {"recipient_id": "123456"}
    assert calls[2]["url"] == "https://discord.com/api/v10/channels/dm-channel/messages"
    assert calls[2]["json"] == {"content": "hello"}
    assert calls[2]["headers"]["Authorization"] == "Bot discord-token"


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

        async def post(self, url: str, json: dict[str, Any], headers: dict[str, str]):
            calls.append({"url": url, "json": json, "headers": headers})
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

    posted_content = calls[2]["json"]["content"]
    assert result["success"] is True
    assert len(posted_content) == 2000
    assert posted_content.endswith("...")
