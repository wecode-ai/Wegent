# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock

import pytest

from app.api import vnc_websocket_middleware as middleware


async def _receive() -> dict[str, str]:
    return {"type": "websocket.disconnect"}


async def _send(_message: object) -> None:
    return None


@pytest.mark.asyncio
async def test_interceptor_routes_only_session_websockets(
    monkeypatch: pytest.MonkeyPatch,
):
    vnc_handler = AsyncMock()
    other_app = AsyncMock()
    monkeypatch.setattr(middleware, "_handle_vnc_ws", vnc_handler)
    app = middleware.create_vnc_interceptor_app(other_app)

    await app(
        {"type": "websocket", "path": "/vnc-proxy/sessions/vnc-session-1"},
        _receive,
        _send,
    )
    await app(
        {"type": "websocket", "path": "/vnc-proxy/device-1"},
        _receive,
        _send,
    )

    vnc_handler.assert_awaited_once()
    other_app.assert_awaited_once()


@pytest.mark.asyncio
async def test_vnc_ticket_query_rejects_extra_and_duplicate_values(
    monkeypatch: pytest.MonkeyPatch,
):
    proxy = AsyncMock()
    monkeypatch.setattr(middleware, "vnc_websocket_proxy", proxy)
    scope = {
        "type": "websocket",
        "path": "/vnc-proxy/sessions/vnc-session-1",
        "headers": [(b"origin", b"https://wework.example.com")],
    }

    for query in (
        b"ticket=single-use",
        b"ticket=single-use&token=jwt",
        b"ticket=first&ticket=second",
    ):
        await middleware._handle_vnc_ws(
            {**scope, "query_string": query}, _receive, _send
        )

    assert [call.args[2] for call in proxy.await_args_list] == [
        "single-use",
        "",
        "",
    ]
    proxy.assert_any_await(
        ANY, "vnc-session-1", "single-use", "https://wework.example.com"
    )


def test_vnc_origin_allowlist_is_exact(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(middleware.settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(
        middleware.settings,
        "VNC_ALLOWED_ORIGINS",
        ["https://wework.example.com", "http://127.0.0.1:*"],
    )
    monkeypatch.setattr(
        middleware.settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example.com",
    )

    assert middleware._origin_allowed("https://wework.example.com")
    assert middleware._origin_allowed("https://backend.example.com")
    assert middleware._origin_allowed("http://127.0.0.1:43127")
    assert not middleware._origin_allowed("https://wework.example.com.evil.test")
    assert not middleware._origin_allowed("https://attacker@wework.example.com")
    assert not middleware._origin_allowed("https://wework.example.com/attacker")
    assert not middleware._origin_allowed("http://127.0.0.2:43127")
