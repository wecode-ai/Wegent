# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for device-backed sandbox execution."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.device_sandbox_service import (
    DeviceSandboxError,
    device_sandbox_service,
)


class TestDeviceSandboxService:
    """Tests for DeviceSandboxService."""

    @pytest.mark.asyncio
    async def test_execute_command_prefers_default_cloud_device(self):
        """Default cloud devices should be preferred over other online devices."""
        online_devices = [
            {
                "device_id": "local-device",
                "device_type": "local",
                "is_default": True,
                "capabilities": ["himalaya_mail"],
            },
            {
                "device_id": "cloud-device",
                "device_type": "cloud",
                "is_default": True,
                "capabilities": ["himalaya_mail"],
            },
        ]
        mock_sio = MagicMock()
        mock_sio.call = AsyncMock(
            return_value={
                "success": True,
                "stdout": "ok",
                "stderr": "",
                "exit_code": 0,
                "execution_time": 0.12,
            }
        )

        with (
            patch(
                "app.services.device_sandbox_service.device_service.get_online_devices",
                AsyncMock(return_value=online_devices),
            ),
            patch(
                "app.services.device_sandbox_service.device_service.get_device_online_info",
                AsyncMock(return_value={"socket_id": "socket-1"}),
            ) as mock_online_info,
            patch(
                "app.services.device_sandbox_service.get_sio",
                return_value=mock_sio,
            ),
        ):
            result = await device_sandbox_service.execute_command(
                db=MagicMock(),
                user_id=1,
                command="himalaya --help",
                required_capability="himalaya_mail",
            )

        assert result["success"] is True
        assert result["device_id"] == "cloud-device"
        mock_online_info.assert_awaited_once_with(1, "cloud-device")
        mock_sio.call.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_execute_command_raises_when_no_compatible_device(self):
        """An explicit error should be raised when no online device matches."""
        with patch(
            "app.services.device_sandbox_service.device_service.get_online_devices",
            AsyncMock(return_value=[]),
        ):
            with pytest.raises(DeviceSandboxError, match="No compatible online device"):
                await device_sandbox_service.execute_command(
                    db=MagicMock(),
                    user_id=1,
                    command="himalaya --help",
                    required_capability="himalaya_mail",
                )
