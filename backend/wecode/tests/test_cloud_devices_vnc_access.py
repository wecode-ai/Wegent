# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock

import pytest

from app.services.device.session_service import DeviceSessionError
from wecode.api import vnc_websocket_middleware
from wecode.service import vnc_session_provider
from wecode.service.vnc_session_service import VncUpstream


@pytest.mark.asyncio
async def test_nevis_provider_keeps_signature_in_backend_upstream_metadata(
    mocker,
    monkeypatch,
):
    mocker.patch.object(
        vnc_session_provider.cloud_device_provider,
        "is_configured",
        return_value=True,
    )
    mocker.patch.object(
        vnc_session_provider.cloud_device_provider,
        "get_status",
        new=AsyncMock(return_value={"cloud_config": {"sandboxId": "sandbox-1"}}),
    )
    mocker.patch.object(
        vnc_session_provider.cloud_device_provider,
        "get_vm_status",
        new=AsyncMock(return_value={"status": "running"}),
    )
    monkeypatch.setattr(
        vnc_session_provider.nevis_settings,
        "NEVIS_BASE_URL",
        "https://nevis.example.com",
    )
    monkeypatch.setattr(
        vnc_session_provider.nevis_settings,
        "NEVIS_MANAGER_ID",
        "manager-1",
    )
    monkeypatch.setattr(
        vnc_session_provider.nevis_settings,
        "NEVIS_SIGNATURE",
        "signature-1",
    )

    upstream = await vnc_session_provider.NevisVncSessionProvider().prepare(
        db=object(),
        user_id=42,
        device_id="device-1",
    )

    assert upstream.url == (
        "wss://nevis.example.com/apis/sandboxes/v1/managers/manager-1/"
        "sandboxes/sandbox-1/vnc"
    )
    assert upstream.headers == {"X-Signature": "signature-1"}
    assert upstream.provider_instance_id == "sandbox-1"
    vnc_session_provider.cloud_device_provider.get_status.assert_awaited_once_with(
        db=ANY,
        user_id=42,
        device_id="device-1",
    )


@pytest.mark.asyncio
async def test_nevis_provider_rejects_a_stopped_sandbox(mocker):
    mocker.patch.object(
        vnc_session_provider.cloud_device_provider,
        "is_configured",
        return_value=True,
    )
    mocker.patch.object(
        vnc_session_provider.cloud_device_provider,
        "get_status",
        new=AsyncMock(return_value={"cloud_config": {"sandboxId": "sandbox-1"}}),
    )
    mocker.patch.object(
        vnc_session_provider.cloud_device_provider,
        "get_vm_status",
        new=AsyncMock(return_value={"status": "stopped"}),
    )

    with pytest.raises(DeviceSessionError, match="not running"):
        await vnc_session_provider.NevisVncSessionProvider().prepare(
            db=object(),
            user_id=42,
            device_id="device-1",
        )


def test_vnc_upstream_connection_is_binary_uncompressed_and_bounded(mocker):
    mock_connect = mocker.patch.object(vnc_websocket_middleware.websockets, "connect")
    upstream = VncUpstream(
        url="wss://nevis.example.com/vnc",
        headers={"X-Signature": "signature-1"},
        provider="nevis",
        provider_instance_id="sandbox-1",
    )

    connection = vnc_websocket_middleware._connect_vnc_upstream(upstream)

    assert connection is mock_connect.return_value
    mock_connect.assert_called_once_with(
        "wss://nevis.example.com/vnc",
        additional_headers={"X-Signature": "signature-1"},
        compression=None,
        proxy=None,
        max_size=64 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
    )


@pytest.mark.asyncio
async def test_vnc_websocket_middleware_accepts_only_session_ticket_path(mocker):
    mock_proxy = mocker.patch.object(
        vnc_websocket_middleware,
        "vnc_websocket_proxy",
        new=AsyncMock(),
    )

    async def receive():
        return {"type": "websocket.disconnect"}

    async def send(_message):
        return None

    await vnc_websocket_middleware._handle_vnc_ws(
        {
            "type": "websocket",
            "path": "/vnc-proxy/sessions/vnc-session-1",
            "query_string": b"ticket=single-use",
            "headers": [(b"origin", b"https://wework.example.com")],
        },
        receive,
        send,
    )

    mock_proxy.assert_awaited_once_with(
        ANY,
        "vnc-session-1",
        "single-use",
        "https://wework.example.com",
    )


@pytest.mark.asyncio
async def test_vnc_websocket_middleware_rejects_extra_or_repeated_query_values(mocker):
    mock_proxy = mocker.patch.object(
        vnc_websocket_middleware,
        "vnc_websocket_proxy",
        new=AsyncMock(),
    )

    async def receive():
        return {"type": "websocket.disconnect"}

    async def send(_message):
        return None

    for query in (
        b"ticket=single-use&token=long-lived-jwt",
        b"ticket=first&ticket=second",
        b"token=long-lived-jwt",
    ):
        await vnc_websocket_middleware._handle_vnc_ws(
            {
                "type": "websocket",
                "path": "/vnc-proxy/sessions/vnc-session-1",
                "query_string": query,
                "headers": [(b"origin", b"https://wework.example.com")],
            },
            receive,
            send,
        )

    assert mock_proxy.await_count == 3
    assert all(call.args[2] == "" for call in mock_proxy.await_args_list)


def test_vnc_origin_allowlist_is_exact(monkeypatch):
    monkeypatch.setattr(
        vnc_websocket_middleware.vnc_settings,
        "VNC_ALLOWED_ORIGINS",
        ["https://wework.example.com"],
    )
    monkeypatch.setattr(
        vnc_websocket_middleware.settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example.com",
    )

    assert vnc_websocket_middleware._origin_allowed("https://wework.example.com")
    assert vnc_websocket_middleware._origin_allowed("https://backend.example.com")
    assert not vnc_websocket_middleware._origin_allowed(
        "https://wework.example.com.evil.test"
    )
    assert not vnc_websocket_middleware._origin_allowed(
        "https://attacker@wework.example.com"
    )
    assert not vnc_websocket_middleware._origin_allowed(
        "https://wework.example.com/attacker"
    )
    assert not vnc_websocket_middleware._origin_allowed(
        "https://wework.example.com?attacker=1"
    )


def test_vnc_origin_allowlist_supports_only_explicit_loopback_port_wildcards(
    monkeypatch,
):
    monkeypatch.setattr(
        vnc_websocket_middleware.vnc_settings,
        "VNC_ALLOWED_ORIGINS",
        ["http://127.0.0.1:*"],
    )
    monkeypatch.setattr(
        vnc_websocket_middleware.settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example.com",
    )
    monkeypatch.setattr(
        vnc_websocket_middleware.settings,
        "ENVIRONMENT",
        "production",
    )

    assert vnc_websocket_middleware._origin_allowed("http://127.0.0.1:43127")
    assert not vnc_websocket_middleware._origin_allowed("http://127.0.0.2:43127")
    assert not vnc_websocket_middleware._origin_allowed(
        "https://wework.example.com:43127"
    )
