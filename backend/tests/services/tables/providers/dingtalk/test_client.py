# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-loop isolation tests for DingTalk table HTTP responses."""

import threading

import pytest

from app.services.tables.providers.dingtalk.client import DingtalkTokenManager


@pytest.mark.asyncio
async def test_token_response_decode_runs_outside_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    decoder_thread: int | None = None

    class FakeResponse:
        content = b'{"accessToken":"token"}'
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            nonlocal decoder_thread
            decoder_thread = threading.get_ident()
            return {"accessToken": "token"}

    class FakeClient:
        def __init__(self, timeout: float):
            assert timeout == 10.0

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(
            self,
            url: str,
            content: bytes,
            headers: dict[str, str],
        ):
            assert url.endswith("/v1.0/oauth2/accessToken")
            assert content == b'{"appKey":"key","appSecret":"secret"}'
            assert headers == {"Content-Type": "application/json"}
            return FakeResponse()

    monkeypatch.setattr(
        "app.services.tables.providers.dingtalk.client.httpx.AsyncClient",
        FakeClient,
    )

    token = await DingtalkTokenManager("key", "secret")._fetch_token()

    assert token == "token"
    assert decoder_thread is not None
    assert decoder_thread != loop_thread
