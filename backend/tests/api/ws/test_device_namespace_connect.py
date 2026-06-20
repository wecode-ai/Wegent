# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from socketio.exceptions import ConnectionRefusedError
from sqlalchemy.exc import OperationalError

from app.api.ws import device_namespace
from app.core.shutdown import shutdown_manager


@pytest.fixture(autouse=True)
def reset_shutdown_manager():
    shutdown_manager.reset()
    yield
    shutdown_manager.reset()


@pytest.fixture
def valid_jwt_auth(monkeypatch):
    monkeypatch.setattr(device_namespace, "is_api_key", lambda token: False)
    monkeypatch.setattr(
        device_namespace,
        "verify_jwt_token",
        lambda token: SimpleNamespace(id=7, user_name="alice"),
    )
    monkeypatch.setattr(device_namespace, "get_token_expiry", lambda token: 123456)


@pytest.mark.asyncio
async def test_connect_rejects_when_session_disappears_before_save(
    valid_jwt_auth,
    monkeypatch,
):
    namespace = device_namespace.DeviceNamespace()
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
    namespace = device_namespace.DeviceNamespace()
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


@pytest.mark.asyncio
async def test_connect_logs_resolved_client_ip_and_forwarding_context(
    valid_jwt_auth,
    monkeypatch,
    caplog,
):
    namespace = device_namespace.DeviceNamespace()
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())

    environ = {
        "HTTP_X_FORWARDED_FOR": "203.0.113.9, 10.0.0.2",
        "HTTP_X_REAL_IP": "198.51.100.10",
        "REMOTE_ADDR": "10.2.0.5",
    }

    with caplog.at_level(logging.INFO, logger=device_namespace.logger.name):
        await namespace.on_connect("sid-1", environ, {"token": "jwt-token"})

    assert (
        "[Device WS] Connection attempt sid=sid-1 client_ip=203.0.113.9 "
        "remote_addr=10.2.0.5 x_forwarded_for=203.0.113.9, 10.0.0.2 "
        "x_real_ip=198.51.100.10"
    ) in caplog.messages
    assert (
        "[Device WS] Connected user=7 (alice) via jwt sid=sid-1 "
        "client_ip=203.0.113.9 remote_addr=10.2.0.5 "
        "x_forwarded_for=203.0.113.9, 10.0.0.2 x_real_ip=198.51.100.10, "
        "awaiting registration"
    ) in caplog.messages


@pytest.mark.asyncio
async def test_connect_rejects_api_key_when_auth_storage_unavailable(
    monkeypatch,
    caplog,
):
    namespace = device_namespace.DeviceNamespace()
    auth_error = OperationalError(
        "SELECT * FROM api_keys",
        {},
        RuntimeError("connection refused"),
    )
    monkeypatch.setattr(device_namespace, "is_api_key", lambda token: True)
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        AsyncMock(side_effect=auth_error),
    )
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())

    with caplog.at_level(logging.ERROR, logger=device_namespace.logger.name):
        with pytest.raises(ConnectionRefusedError) as exc_info:
            await namespace.on_connect(
                "sid-1",
                {"REMOTE_ADDR": "127.0.0.1"},
                {"token": "wg-api-key"},
            )

    assert str(exc_info.value) == "Authentication service unavailable"
    assert (
        "[Device WS] API key authentication storage unavailable sid=sid-1: "
        "OperationalError"
    ) in caplog.messages
    namespace.save_session.assert_not_awaited()
    namespace.enter_room.assert_not_awaited()
