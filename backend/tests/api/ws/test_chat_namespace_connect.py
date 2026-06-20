# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.ws import chat_namespace
from app.core.shutdown import shutdown_manager


@pytest.fixture(autouse=True)
def reset_shutdown_manager():
    shutdown_manager.reset()
    yield
    shutdown_manager.reset()


@pytest.fixture
def valid_jwt_auth(monkeypatch):
    monkeypatch.setattr(
        chat_namespace,
        "verify_jwt_token",
        lambda token: SimpleNamespace(id=7, user_name="alice"),
    )
    monkeypatch.setattr(chat_namespace, "get_token_expiry", lambda token: 123456)


@pytest.mark.asyncio
async def test_connect_rejects_when_session_disappears_before_save(
    valid_jwt_auth,
    monkeypatch,
):
    namespace = chat_namespace.ChatNamespace()
    save_session = AsyncMock(side_effect=KeyError("Session not found"))
    enter_room = AsyncMock()
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await namespace.on_connect(
            "sid-1",
            {"REMOTE_ADDR": "127.0.0.1"},
            {"token": "jwt-token"},
        )

    save_session.assert_awaited_once()
    enter_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_connect_rejects_when_session_disappears_before_room_join(
    valid_jwt_auth,
    monkeypatch,
):
    namespace = chat_namespace.ChatNamespace()
    save_session = AsyncMock()
    enter_room = AsyncMock(side_effect=KeyError("sid-1"))
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await namespace.on_connect(
            "sid-1",
            {"REMOTE_ADDR": "127.0.0.1"},
            {"token": "jwt-token"},
        )

    save_session.assert_awaited_once()
    enter_room.assert_awaited_once_with("sid-1", "user:7")
