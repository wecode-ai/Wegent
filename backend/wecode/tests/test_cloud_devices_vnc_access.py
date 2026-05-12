# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.models.user import User
from wecode.api import cloud_devices
from wecode.api.vnc_websocket_middleware import _handle_vnc_ws


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_admin_can_access_other_users_vnc_config(
    test_client: TestClient,
    test_user: User,
    test_admin_token: str,
    mocker,
    monkeypatch,
):
    mocker.patch.object(
        cloud_devices.cloud_device_provider, "is_configured", return_value=True
    )
    mock_get_status = mocker.patch.object(
        cloud_devices.cloud_device_provider,
        "get_status",
        new=AsyncMock(
            return_value={
                "cloud_config": {
                    "sandboxId": "sandbox-1",
                }
            }
        ),
    )
    monkeypatch.setattr(
        cloud_devices.nevis_settings, "NEVIS_BASE_URL", "https://nevis.example.com"
    )
    monkeypatch.setattr(cloud_devices.nevis_settings, "NEVIS_MANAGER_ID", "manager-1")
    monkeypatch.setattr(cloud_devices.nevis_settings, "NEVIS_SIGNATURE", "signature-1")

    response = test_client.get(
        f"/api/cloud-devices/device-1/vnc-config?user_id={test_user.id}",
        headers=_auth_headers(test_admin_token),
    )

    assert response.status_code == 200
    assert response.json() == {
        "wss_url": "wss://nevis.example.com/apis/sandboxes/v1/managers/manager-1/sandboxes/sandbox-1/vnc",
        "signature": "signature-1",
        "sandbox_id": "sandbox-1",
    }
    mock_get_status.assert_awaited_once_with(
        db=ANY,
        user_id=test_user.id,
        device_id="device-1",
    )


def test_non_admin_cannot_access_other_users_vnc_config(
    test_client: TestClient,
    test_admin_user: User,
    test_token: str,
    mocker,
):
    mocker.patch.object(
        cloud_devices.cloud_device_provider, "is_configured", return_value=True
    )
    mock_get_status = mocker.patch.object(
        cloud_devices.cloud_device_provider,
        "get_status",
        new=AsyncMock(),
    )

    response = test_client.get(
        f"/api/cloud-devices/device-1/vnc-config?user_id={test_admin_user.id}",
        headers=_auth_headers(test_token),
    )

    assert response.status_code == 403
    assert (
        response.json()["detail"]
        == "Only admins can access another user's cloud device"
    )
    mock_get_status.assert_not_called()


def test_admin_can_access_other_users_file_config(
    test_client: TestClient,
    test_user: User,
    test_admin_token: str,
    mocker,
):
    mocker.patch.object(
        cloud_devices.cloud_device_provider, "is_configured", return_value=True
    )
    mock_get_status = mocker.patch.object(
        cloud_devices.cloud_device_provider,
        "get_status",
        new=AsyncMock(
            return_value={
                "cloud_config": {
                    "sandboxId": "sandbox-2",
                }
            }
        ),
    )
    mocker.patch.object(
        cloud_devices.cloud_device_provider,
        "get_vm_status",
        new=AsyncMock(
            return_value={
                "sandbox_id": "sandbox-2",
                "ip_address": "10.0.0.9",
            }
        ),
    )
    mocker.patch.object(
        cloud_devices,
        "_is_files_service_available",
        new=AsyncMock(return_value=True),
    )

    response = test_client.get(
        f"/api/cloud-devices/device-2/file-config?user_id={test_user.id}",
        headers=_auth_headers(test_admin_token),
    )

    assert response.status_code == 200
    assert response.json() == {
        "sandbox_id": "sandbox-2",
        "ip_address": "10.0.0.9",
        "files_url": "http://10.0.0.9:8080/files/",
        "available": True,
    }
    mock_get_status.assert_awaited_once_with(
        db=ANY,
        user_id=test_user.id,
        device_id="device-2",
    )


@pytest.mark.asyncio
async def test_vnc_websocket_middleware_forwards_user_id(mocker):
    mock_proxy = mocker.patch(
        "wecode.api.cloud_devices.vnc_websocket_proxy",
        new=AsyncMock(),
    )

    async def receive():
        return {"type": "websocket.disconnect"}

    async def send(_message):
        return None

    await _handle_vnc_ws(
        {
            "type": "websocket",
            "path": "/api/cloud-devices/device-3/vnc-ws",
            "query_string": b"token=test-token&user_id=42",
            "headers": [],
        },
        receive,
        send,
    )

    mock_proxy.assert_awaited_once_with(ANY, "device-3", "test-token", 42)
