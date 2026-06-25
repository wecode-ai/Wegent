# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
import socketio

import executor.modes.local.websocket_client as websocket_client_module
from executor.config import config
from executor.modes.local.websocket_client import (
    WebSocketClient,
    _is_usable_device_ip,
    build_runtime_auth_file_report,
)


def test_build_runtime_auth_file_report_reports_codex_auth_presence(tmp_path):
    report = build_runtime_auth_file_report(home=tmp_path)

    assert report == {
        "codex": {
            "target_path": "~/.codex/auth.json",
            "exists": False,
        }
    }

    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    (codex_dir / "auth.json").write_text('{"token":"secret"}', encoding="utf-8")

    assert build_runtime_auth_file_report(home=tmp_path)["codex"]["exists"] is True


def test_usable_device_ip_rejects_loopback_and_accepts_non_loopback_address():
    assert _is_usable_device_ip("192.0.2.10") is True
    assert _is_usable_device_ip("192.168.1.8") is True
    assert _is_usable_device_ip("127.0.0.1") is False
    assert _is_usable_device_ip("localhost") is False


def test_connected_accepts_namespace_connected_during_connect_callback():
    client = WebSocketClient.__new__(WebSocketClient)

    class FakeSocket:
        connected = False
        namespaces = {"/local-executor": "sid-1"}

    client.sio = FakeSocket()
    client._connected = True

    assert client.connected is True


@pytest.mark.asyncio
async def test_reconnect_resets_socket_state_and_registers_device():
    client = WebSocketClient.__new__(WebSocketClient)
    connect_called = False
    register_called = False

    class FakeSocket:
        connected = True

        async def disconnect(self):
            self.connected = False

    async def fake_connect(wait_timeout=30.0):
        nonlocal connect_called
        connect_called = True
        assert wait_timeout == 12.0
        assert client._connected is False
        assert client._registered is False
        assert client._connecting is False
        return True

    async def fake_register_device():
        nonlocal register_called
        register_called = True
        client._registered = True
        return True

    client.sio = FakeSocket()
    client._connected = True
    client._registered = True
    client._connecting = True
    client._was_registered = True
    client.connect = fake_connect
    client.register_device = fake_register_device

    assert await client.reconnect(wait_timeout=12.0) is True

    assert client.sio.connected is False
    assert connect_called is True
    assert register_called is True
    assert client._registered is True


@pytest.mark.asyncio
async def test_connect_disconnects_stale_engineio_transport_before_connecting():
    client = WebSocketClient.__new__(WebSocketClient)

    class FakeEngineIO:
        state = "connected"

    class FakeSocket:
        connected = False
        namespaces = {}

        def __init__(self):
            self.eio = FakeEngineIO()
            self.disconnect_called = False
            self.connect_called = False

        async def disconnect(self):
            self.disconnect_called = True
            self.eio.state = "disconnected"

        async def connect(self, *args, **kwargs):
            self.connect_called = True
            assert self.eio.state == "disconnected"
            client._connected = True

    client.sio = FakeSocket()
    client.backend_url = "http://localhost:8000"
    client.auth_token = "wg-test"
    client._connected = False
    client._registered = True
    client._connecting = False
    client._connection_error = None

    assert await client.connect(wait_timeout=12.0) is True

    assert client.sio.disconnect_called is True
    assert client.sio.connect_called is True
    assert client._registered is False


@pytest.mark.asyncio
async def test_send_heartbeat_treats_socketio_timeout_as_timeout(monkeypatch):
    client = WebSocketClient.__new__(WebSocketClient)
    warnings = []

    class FakeSocket:
        async def call(self, *args, **kwargs):
            raise socketio.exceptions.TimeoutError()

    client.sio = FakeSocket()
    client._connected = True
    client._socketio_connected = lambda: True
    client.device_id = "device-1"
    client.capability_reporter = type(
        "FakeCapabilityReporter",
        (),
        {
            "build_report": lambda self: {
                "revision": 1,
                "digest": "digest",
                "full": False,
            }
        },
    )()
    client._get_runtime_transfer_host = lambda: "127.0.0.1"
    monkeypatch.setattr(websocket_client_module.logger, "warning", warnings.append)

    assert await client.send_heartbeat(timeout=0.01) is False
    assert "Heartbeat timeout" in warnings


@pytest.mark.asyncio
async def test_send_heartbeat_uses_configured_default_timeout(monkeypatch):
    client = WebSocketClient.__new__(WebSocketClient)

    class FakeSocket:
        def __init__(self):
            self.timeout = None

        async def call(self, *args, **kwargs):
            self.timeout = kwargs["timeout"]
            return {"success": True}

    fake_socket = FakeSocket()
    client.sio = fake_socket
    client._connected = True
    client._socketio_connected = lambda: True
    client.device_id = "device-1"
    client.capability_reporter = type(
        "FakeCapabilityReporter",
        (),
        {
            "build_report": lambda self: {
                "revision": 1,
                "digest": "digest",
                "full": False,
            }
        },
    )()
    client._get_runtime_transfer_host = lambda: "127.0.0.1"
    monkeypatch.setattr(config, "LOCAL_HEARTBEAT_CALL_TIMEOUT", 12)

    assert await client.send_heartbeat() is True
    assert fake_socket.timeout == 12
