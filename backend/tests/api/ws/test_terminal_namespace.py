# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the browser terminal Socket.IO namespace."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.ws import terminal_namespace
from app.api.ws.terminal_namespace import TerminalNamespace
from app.services.device.terminal_session_service import TerminalSessionRecord


def _record(user_id: int = 7, device_id: str = "device-abc") -> TerminalSessionRecord:
    return TerminalSessionRecord(
        session_id="terminal-1",
        user_id=user_id,
        device_id=device_id,
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )


@pytest.fixture
def valid_jwt_auth(monkeypatch):
    monkeypatch.setattr(
        terminal_namespace,
        "verify_jwt_token",
        lambda token: SimpleNamespace(id=7, user_name="alice"),
    )
    monkeypatch.setattr(
        terminal_namespace,
        "get_token_expiry",
        lambda token: int(
            (datetime.now(timezone.utc) + timedelta(minutes=5)).timestamp()
        ),
    )


@pytest.mark.asyncio
async def test_connect_uses_existing_jwt_auth(valid_jwt_auth, monkeypatch):
    namespace = TerminalNamespace()
    save_session = AsyncMock()
    enter_room = AsyncMock()
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)

    await namespace.on_connect(
        "browser-sid",
        {"REMOTE_ADDR": "127.0.0.1"},
        {"token": "jwt-token"},
    )

    save_session.assert_awaited_once()
    saved_session = save_session.await_args.args[1]
    assert saved_session["user_id"] == 7
    assert saved_session["auth_token"] == "jwt-token"
    enter_room.assert_awaited_once_with("browser-sid", "user:7")


@pytest.mark.asyncio
async def test_attach_enters_terminal_room_when_owner_matches(monkeypatch):
    namespace = TerminalNamespace()
    service = SimpleNamespace(authorize=AsyncMock(return_value=_record()))
    get_session = AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999})
    save_session = AsyncMock()
    enter_room = AsyncMock()
    sio = SimpleNamespace(call=AsyncMock(return_value={"success": True}))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(namespace, "get_session", get_session)
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {"session_id": "terminal-1"},
    )

    assert result == {
        "success": True,
        "session_id": "terminal-1",
        "device_id": "device-abc",
        "project_id": 123,
        "path": "/repo",
    }
    service.authorize.assert_awaited_once_with("terminal-1", user_id=7)
    enter_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    sio.call.assert_awaited_once_with(
        "terminal:attach",
        {"session_id": "terminal-1"},
        to="device-sid",
        namespace="/local-executor",
        timeout=5,
    )
    saved_session = save_session.await_args.args[1]
    assert saved_session["terminal_session_id"] == "terminal-1"


@pytest.mark.asyncio
async def test_attach_leaves_previous_terminal_room_when_switching(monkeypatch):
    namespace = TerminalNamespace()
    record = _record()
    service = SimpleNamespace(authorize=AsyncMock(return_value=record))
    get_session = AsyncMock(
        return_value={
            "user_id": 7,
            "token_exp": 9999999999,
            "terminal_session_id": "terminal-old",
        }
    )
    save_session = AsyncMock()
    enter_room = AsyncMock()
    leave_room = AsyncMock()
    sio = SimpleNamespace(call=AsyncMock(return_value={"success": True}))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(namespace, "get_session", get_session)
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)
    monkeypatch.setattr(namespace, "leave_room", leave_room)

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {"session_id": "terminal-1"},
    )

    assert result["success"] is True
    leave_room.assert_awaited_once_with("browser-sid", "terminal:terminal-old")
    enter_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    saved_session = save_session.await_args.args[1]
    assert saved_session["terminal_session_id"] == "terminal-1"


@pytest.mark.asyncio
async def test_attach_leaves_room_when_executor_attach_fails(monkeypatch):
    namespace = TerminalNamespace()
    service = SimpleNamespace(authorize=AsyncMock(return_value=_record()))
    sio = SimpleNamespace(call=AsyncMock(side_effect=TimeoutError("timed out")))
    save_session = AsyncMock()
    enter_room = AsyncMock()
    leave_room = AsyncMock()
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999}),
    )
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)
    monkeypatch.setattr(namespace, "leave_room", leave_room)

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {"session_id": "terminal-1"},
    )

    assert result == {"error": "Failed to attach terminal executor"}
    enter_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    leave_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    save_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_attach_rejects_sessions_owned_by_other_users(monkeypatch):
    namespace = TerminalNamespace()
    service = SimpleNamespace(authorize=AsyncMock(return_value=None))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999}),
    )
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {"session_id": "terminal-1"},
    )

    assert result == {"error": "Terminal session not found or access denied"}
    namespace.enter_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_input_relays_to_executor_socket(monkeypatch):
    namespace = TerminalNamespace()
    service = SimpleNamespace(authorize=AsyncMock(return_value=_record()))
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": 7,
                "token_exp": 9999999999,
                "terminal_session_id": "terminal-1",
            }
        ),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once_with(
        "terminal:input",
        {"session_id": "terminal-1", "data": "ls\n"},
        to="device-sid",
        namespace="/local-executor",
    )


@pytest.mark.asyncio
async def test_terminal_close_relays_and_deletes_session(monkeypatch):
    namespace = TerminalNamespace()
    service = SimpleNamespace(
        authorize=AsyncMock(return_value=_record()),
        delete=AsyncMock(),
    )
    sio = SimpleNamespace(emit=AsyncMock())
    session = {
        "user_id": 7,
        "token_exp": 9999999999,
        "terminal_session_id": "terminal-1",
    }
    get_session = AsyncMock(return_value=session)
    save_session = AsyncMock()
    leave_room = AsyncMock()
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(namespace, "get_session", get_session)
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "leave_room", leave_room)

    result = await namespace.on_terminal_close(
        "browser-sid",
        {"session_id": "terminal-1"},
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once_with(
        "terminal:close",
        {"session_id": "terminal-1"},
        to="device-sid",
        namespace="/local-executor",
    )
    service.delete.assert_awaited_once_with("terminal-1")
    leave_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    save_session.assert_awaited_once()
    saved_session = save_session.await_args.args[1]
    assert saved_session["terminal_session_id"] is None
