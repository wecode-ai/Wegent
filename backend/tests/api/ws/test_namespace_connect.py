# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from socketio.exceptions import ConnectionRefusedError

from app.api.ws import chat_namespace, device_namespace
from app.api.ws.chat_namespace import ChatNamespace


@pytest.mark.asyncio
async def test_device_connect_rejects_when_session_disappears(monkeypatch):
    namespace = device_namespace.DeviceNamespace("/local-executor")
    namespace.enter_room = AsyncMock()

    async def session_disappeared(*args, **kwargs):
        raise KeyError("Session not found")

    namespace.save_session = session_disappeared

    monkeypatch.setattr(device_namespace, "is_api_key", lambda token: False)
    monkeypatch.setattr(
        device_namespace,
        "verify_jwt_token",
        lambda token: SimpleNamespace(id=7, user_name="testuser"),
    )
    monkeypatch.setattr(device_namespace, "get_token_expiry", lambda token: None)

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await namespace.on_connect("sid-1", {}, {"token": "token"})

    namespace.enter_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_chat_connect_rejects_when_session_disappears(monkeypatch):
    namespace = ChatNamespace("/chat")
    namespace.enter_room = AsyncMock()

    async def session_disappeared(*args, **kwargs):
        raise KeyError("Session not found")

    namespace.save_session = session_disappeared

    monkeypatch.setattr(
        chat_namespace,
        "verify_jwt_token",
        lambda token: SimpleNamespace(id=7, user_name="testuser"),
    )
    monkeypatch.setattr(chat_namespace, "get_token_expiry", lambda token: None)

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await namespace.on_connect("sid-1", {}, {"token": "token"})

    namespace.enter_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_device_connect_rejects_when_room_join_session_disappears(monkeypatch):
    namespace = device_namespace.DeviceNamespace("/local-executor")
    namespace.save_session = AsyncMock()

    async def session_disappeared(*args, **kwargs):
        raise KeyError("sid-1")

    namespace.enter_room = session_disappeared

    monkeypatch.setattr(device_namespace, "is_api_key", lambda token: False)
    monkeypatch.setattr(
        device_namespace,
        "verify_jwt_token",
        lambda token: SimpleNamespace(id=7, user_name="testuser"),
    )
    monkeypatch.setattr(device_namespace, "get_token_expiry", lambda token: None)

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await namespace.on_connect("sid-1", {}, {"token": "token"})

    namespace.save_session.assert_awaited_once()
