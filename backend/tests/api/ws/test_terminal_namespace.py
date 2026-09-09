# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the browser terminal Socket.IO namespace."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.api.ws import terminal_namespace
from app.api.ws.terminal_namespace import TerminalNamespace
from app.services.device.terminal_session_service import TerminalSessionRecord


def _record(
    user_id: int = 7,
    device_id: str = "device-abc",
    authorization_epoch: int = 0,
) -> TerminalSessionRecord:
    return TerminalSessionRecord(
        session_id="terminal-1",
        user_id=user_id,
        device_id=device_id,
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        authorization_epoch=authorization_epoch,
    )


def _attached_session(
    record: TerminalSessionRecord | None = None,
    *,
    user_id: int = 7,
) -> dict:
    authorization = record or _record(user_id=user_id)
    return {
        "user_id": user_id,
        "token_exp": 9999999999,
        "terminal_session_id": authorization.session_id,
        "terminal_consumer_id": "consumer-1",
        "terminal_protocol_version": 2,
        "terminal_authorization": authorization,
    }


def _service(**values):
    values.setdefault("is_authorization_current", Mock(return_value=True))
    return SimpleNamespace(**values)


@pytest.fixture(autouse=True)
def active_device_socket(monkeypatch):
    monkeypatch.setattr(
        terminal_namespace,
        "device_service",
        SimpleNamespace(
            get_device_online_info=AsyncMock(return_value={"socket_id": "device-sid"})
        ),
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
    assert saved_session["terminal_authorization"] is None
    enter_room.assert_awaited_once_with("browser-sid", "user:7")


@pytest.mark.asyncio
async def test_attach_enters_terminal_room_when_owner_matches(monkeypatch):
    namespace = TerminalNamespace()
    record = _record()
    service = _service(authorize=AsyncMock(return_value=record))
    get_session = AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999})
    save_session = AsyncMock()
    enter_room = AsyncMock()
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(namespace, "get_session", get_session)
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": 7,
        },
    )

    assert result == {
        "success": True,
        "protocol_version": 2,
        "session_id": "terminal-1",
        "device_id": "device-abc",
        "project_id": 123,
        "path": "/repo",
    }
    service.authorize.assert_awaited_once_with(
        "terminal-1",
        user_id=7,
        refresh=True,
    )
    enter_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    sio.call.assert_awaited_once_with(
        "terminal:attach",
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": 7,
        },
        to="device-sid",
        namespace="/local-executor",
        timeout=5,
    )
    saved_session = save_session.await_args.args[1]
    assert saved_session["terminal_session_id"] == "terminal-1"
    assert saved_session["terminal_authorization"] == record


@pytest.mark.asyncio
async def test_attach_leaves_previous_terminal_room_when_switching(monkeypatch):
    namespace = TerminalNamespace()
    record = _record()
    service = _service(authorize=AsyncMock(return_value=record))
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
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(namespace, "get_session", get_session)
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", enter_room)
    monkeypatch.setattr(namespace, "leave_room", leave_room)

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": 0,
        },
    )

    assert result["success"] is True
    leave_room.assert_awaited_once_with("browser-sid", "terminal:terminal-old")
    enter_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    saved_session = save_session.await_args.args[1]
    assert saved_session["terminal_session_id"] == "terminal-1"


@pytest.mark.asyncio
async def test_attach_targets_and_rebinds_the_current_executor_socket(monkeypatch):
    namespace = TerminalNamespace()
    record = _record()
    rebound = replace(record, socket_id="current-device-sid")
    service = _service(
        authorize=AsyncMock(return_value=record),
        rebind_socket=AsyncMock(return_value=rebound),
    )
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        terminal_namespace,
        "device_service",
        SimpleNamespace(
            get_device_online_info=AsyncMock(
                return_value={"socket_id": "current-device-sid"}
            )
        ),
    )
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999}),
    )
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": 0,
        },
    )

    assert result["success"] is True
    assert sio.call.await_args.kwargs["to"] == "current-device-sid"
    service.rebind_socket.assert_awaited_once_with(
        record,
        "current-device-sid",
    )
    saved_session = namespace.save_session.await_args.args[1]
    assert saved_session["terminal_authorization"] == rebound


@pytest.mark.asyncio
async def test_attach_leaves_room_when_executor_attach_fails(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(authorize=AsyncMock(return_value=_record()))
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
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": 0,
        },
    )

    assert result == {"error": "Failed to attach terminal executor"}
    enter_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    leave_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    save_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_attach_rejects_sessions_owned_by_other_users(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(authorize=AsyncMock(return_value=None))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999}),
    )
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": 0,
        },
    )

    assert result == {"error": "Terminal session not found or access denied"}
    namespace.enter_room.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "last_acked_sequence",
    [None, -1, 1.0, "1", True],
)
async def test_attach_rejects_invalid_last_acked_sequence_without_redis(
    monkeypatch,
    last_acked_sequence,
):
    namespace = TerminalNamespace()
    service = _service(authorize=AsyncMock())
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "token_exp": 9999999999}),
    )

    result = await namespace.on_terminal_attach(
        "browser-sid",
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "last_acked_sequence": last_acked_sequence,
        },
    )

    assert result == {"error": "Invalid last_acked_sequence"}
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_ack_relays_with_bound_authorization_without_redis(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
    )
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    metric = Mock()
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(terminal_namespace, "record_terminal_event", metric)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_ack(
        "browser-sid",
        {"session_id": "terminal-1", "sequence": 8},
    )

    assert result == {"success": True}
    sio.call.assert_awaited_once_with(
        "terminal:ack",
        {
            "session_id": "terminal-1",
            "consumer_id": "consumer-1",
            "sequence": 8,
        },
        to="device-sid",
        namespace="/local-executor",
        timeout=5,
    )
    service.authorize.assert_not_awaited()
    metric.assert_called_once_with(source="browser", event="ack")


@pytest.mark.asyncio
async def test_terminal_ack_rejects_unattached_session_without_redis(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
    )
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": 7,
                "token_exp": 9999999999,
                "terminal_session_id": None,
                "terminal_authorization": None,
            }
        ),
    )

    result = await namespace.on_terminal_ack(
        "browser-sid",
        {"session_id": "terminal-1", "sequence": 1},
    )

    assert result == {"error": "Terminal session is not attached"}
    sio.call.assert_not_awaited()
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_ack_rejects_cross_session_without_redis(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
    )
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_ack(
        "browser-sid",
        {"session_id": "terminal-other", "sequence": 1},
    )

    assert result == {"error": "Terminal session is not attached"}
    sio.call.assert_not_awaited()
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("sequence", [None, 0, -1, 1.0, "1", True])
async def test_terminal_ack_rejects_invalid_sequence(monkeypatch, sequence):
    namespace = TerminalNamespace()
    service = _service(is_revoked=Mock(return_value=False))
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_ack(
        "browser-sid",
        {"session_id": "terminal-1", "sequence": sequence},
    )

    assert result == {"error": "Invalid terminal sequence"}
    sio.call.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_input_relays_to_executor_socket(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
    )
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once_with(
        "terminal:input",
        {
            "session_id": "terminal-1",
            "consumer_id": "consumer-1",
            "data": "ls\n",
        },
        to="device-sid",
        namespace="/local-executor",
    )
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_input_rejects_unattached_session_without_redis(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": 7,
                "token_exp": 9999999999,
                "terminal_session_id": None,
                "terminal_authorization": None,
            }
        ),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"error": "Terminal session is not attached"}
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_input_rejects_cross_user_bound_authorization(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(is_revoked=Mock(return_value=False))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session(_record(user_id=8), user_id=7)),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"error": "Terminal session not found or access denied"}


@pytest.mark.asyncio
async def test_terminal_input_rejects_expired_bound_authorization(monkeypatch):
    namespace = TerminalNamespace()
    expired = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-abc",
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    service = _service(is_revoked=Mock(return_value=False))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session(expired)),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"error": "Terminal session expired"}
    service.is_revoked.assert_not_called()


@pytest.mark.asyncio
async def test_terminal_input_rejects_locally_revoked_authorization(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(is_revoked=Mock(return_value=True))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"error": "Terminal session not found or access denied"}


@pytest.mark.asyncio
async def test_terminal_input_refreshes_authorization_after_listener_resync(
    monkeypatch,
):
    namespace = TerminalNamespace()
    session = _attached_session()
    refreshed = _record(authorization_epoch=1)
    service = _service(
        is_authorization_current=Mock(return_value=False),
        is_revoked=Mock(return_value=False),
        authorize=AsyncMock(return_value=refreshed),
    )
    save_session = AsyncMock()
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=session),
    )
    monkeypatch.setattr(namespace, "save_session", save_session)

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"success": True}
    service.authorize.assert_awaited_once_with(
        "terminal-1",
        user_id=7,
        refresh=True,
    )
    assert session["terminal_authorization"] is refreshed
    save_session.assert_awaited_once_with("browser-sid", session)
    service.is_revoked.assert_called_once_with("terminal-1")
    sio.emit.assert_awaited_once()


@pytest.mark.asyncio
async def test_terminal_input_requires_reattach_when_resynced_routing_changes(
    monkeypatch,
):
    namespace = TerminalNamespace()
    refreshed = _record(device_id="device-other")
    service = _service(
        is_authorization_current=Mock(return_value=False),
        is_revoked=Mock(return_value=False),
        authorize=AsyncMock(return_value=refreshed),
    )
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_input(
        "browser-sid",
        {"session_id": "terminal-1", "data": "ls\n"},
    )

    assert result == {"error": "Terminal session must be reattached"}
    service.is_revoked.assert_not_called()


@pytest.mark.asyncio
async def test_terminal_resize_uses_bound_authorization_without_redis(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
    )
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_resize(
        "browser-sid",
        {"session_id": "terminal-1", "rows": 40, "cols": 120},
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once_with(
        "terminal:resize",
        {
            "session_id": "terminal-1",
            "consumer_id": "consumer-1",
            "rows": 40,
            "cols": 120,
        },
        to="device-sid",
        namespace="/local-executor",
    )
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_close_relays_and_deletes_session(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
        delete=AsyncMock(),
    )
    sio = SimpleNamespace(
        call=AsyncMock(return_value={"success": True, "protocol_version": 2})
    )
    session = _attached_session()
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
    sio.call.assert_awaited_once_with(
        "terminal:close",
        {
            "session_id": "terminal-1",
            "consumer_id": "consumer-1",
        },
        to="device-sid",
        namespace="/local-executor",
        timeout=5,
    )
    service.delete.assert_awaited_once_with("terminal-1")
    leave_room.assert_awaited_once_with("browser-sid", "terminal:terminal-1")
    save_session.assert_awaited_once()
    saved_session = save_session.await_args.args[1]
    assert saved_session["terminal_session_id"] is None
    assert saved_session["terminal_authorization"] is None
    service.authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_close_keeps_record_when_executor_does_not_ack(monkeypatch):
    namespace = TerminalNamespace()
    service = _service(
        authorize=AsyncMock(),
        is_revoked=Mock(return_value=False),
        delete=AsyncMock(),
    )
    sio = SimpleNamespace(call=AsyncMock(side_effect=TimeoutError("timeout")))
    monkeypatch.setattr(terminal_namespace, "terminal_session_service", service)
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value=_attached_session()),
    )

    result = await namespace.on_terminal_close(
        "browser-sid",
        {"session_id": "terminal-1"},
    )

    assert result == {"error": "Failed to close terminal executor"}
    service.delete.assert_not_awaited()


def test_terminal_hot_path_events_skip_generic_payload_tracing():
    assert {
        "terminal:ack",
        "terminal:input",
        "terminal:resize",
    } <= terminal_namespace.TERMINAL_TRACE_EXCLUDED_EVENTS
    assert "terminal:attach" not in terminal_namespace.TERMINAL_TRACE_EXCLUDED_EVENTS
    assert "terminal:close" not in terminal_namespace.TERMINAL_TRACE_EXCLUDED_EVENTS
