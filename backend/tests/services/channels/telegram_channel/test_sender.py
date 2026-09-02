# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import threading
from typing import Any

import httpx
import pytest

from app.services.channels.telegram.sender import TelegramBotSender


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
async def test_send_text_message_retries_retryable_telegram_errors(
    monkeypatch: pytest.MonkeyPatch,
):
    calls: list[dict[str, Any]] = []
    decoder_threads: list[int] = []
    loop_thread = threading.get_ident()

    async def fake_sleep(delay: float) -> None:
        calls.append({"sleep": delay})

    class FakeClient:
        attempts = 0

        def __init__(self, timeout: float):
            calls.append({"timeout": timeout})

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, content: bytes, headers: dict[str, str]):
            FakeClient.attempts += 1
            calls.append({"url": url, "content": content, "headers": headers})
            if FakeClient.attempts == 1:
                raise httpx.ReadTimeout("")
            return FakeResponse(
                {
                    "ok": True,
                    "result": {
                        "message_id": 42,
                    },
                },
                decoder_threads,
            )

    monkeypatch.setattr(
        "app.services.channels.telegram.sender.httpx.AsyncClient", FakeClient
    )
    monkeypatch.setattr(
        "app.services.channels.telegram.sender.asyncio.sleep", fake_sleep
    )

    result = await TelegramBotSender("telegram-token").send_text_message(
        chat_id=123456,
        text="hello",
    )

    assert result["success"] is True
    assert FakeClient.attempts == 2
    assert calls[1]["url"] == "https://api.telegram.org/bottelegram-token/sendMessage"
    assert calls[1]["content"] == b'{"chat_id":123456,"text":"hello"}'
    assert calls[2] == {"sleep": 0.5}
    assert len(decoder_threads) == 1
    assert decoder_threads[0] != loop_thread
