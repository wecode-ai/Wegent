# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor.modes.local.websocket_client import (
    WebSocketClient,
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
