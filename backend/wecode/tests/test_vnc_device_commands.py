# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.device.command_registry import resolve_local_device_command
from wecode.service.vnc_clipboard_registration import register_vnc_clipboard_commands


def _ensure_vnc_commands_registered() -> None:
    if resolve_local_device_command("vnc_clipboard_read") is None:
        register_vnc_clipboard_commands()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command_key",
    ["vnc_clipboard_read", "vnc_clipboard_write"],
)
@pytest.mark.parametrize("device_type", ["remote", "local", "app"])
async def test_non_cloud_device_rejects_cloud_desktop_clipboard_commands(
    monkeypatch: pytest.MonkeyPatch,
    command_key: str,
    device_type: str,
) -> None:
    from app.services.device import command_service

    _ensure_vnc_commands_registered()

    online_mock = AsyncMock()
    execute_mock = AsyncMock()
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: SimpleNamespace(
            name=f"{device_type}-device",
            json={"spec": {"deviceType": device_type}},
        ),
    )
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info_by_type",
        online_mock,
    )
    monkeypatch.setattr(
        command_service.local_device_command_service,
        "execute_command",
        execute_mock,
    )

    with pytest.raises(
        command_service.DeviceCommandError,
        match=f"'{command_key}' is not supported for {device_type} devices",
    ):
        await command_service.execute_configured_device_command(
            db=object(),
            user_id=7,
            device_id=f"{device_type}-device",
            command_key=command_key,
        )

    online_mock.assert_not_awaited()
    execute_mock.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command_key",
    ["vnc_clipboard_read", "vnc_clipboard_write"],
)
async def test_cloud_device_keeps_desktop_clipboard_commands(
    monkeypatch: pytest.MonkeyPatch,
    command_key: str,
) -> None:
    from app.services.device import command_service

    _ensure_vnc_commands_registered()

    online_mock = AsyncMock(return_value={"socket_id": "socket-cloud"})
    execute_mock = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: SimpleNamespace(
            name="cloud-device",
            json={
                "spec": {
                    "deviceType": "cloud",
                    "cloudConfig": {"deviceId": "runtime-cloud"},
                }
            },
        ),
    )
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info_by_type",
        online_mock,
    )
    monkeypatch.setattr(
        command_service.local_device_command_service,
        "execute_command",
        execute_mock,
    )

    result = await command_service.execute_configured_device_command(
        db=object(),
        user_id=7,
        device_id="cloud-device",
        command_key=command_key,
    )

    assert result["success"] is True
    online_mock.assert_awaited_once_with(
        7,
        "runtime-cloud",
        command_service.DeviceType.CLOUD,
    )
    assert execute_mock.await_args.kwargs["device_id"] == "runtime-cloud"
