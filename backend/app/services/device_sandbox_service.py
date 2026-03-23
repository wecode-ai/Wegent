# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Device-backed sandbox execution helpers."""

import logging
import time
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.socketio import get_sio
from app.schemas.device import DeviceType
from app.services.device_service import device_service

logger = logging.getLogger(__name__)


class DeviceSandboxError(RuntimeError):
    """Raised when a device-backed sandbox command cannot be executed."""


class DeviceSandboxService:
    """Service for forwarding sandbox commands to an online user device."""

    async def execute_command(
        self,
        db: Session,
        user_id: int,
        command: str,
        working_dir: str = "/home/user",
        timeout_seconds: int = 300,
        required_capability: Optional[str] = None,
        device_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute a command on a user's online device via Socket.IO."""
        target_device = await self._select_target_device(
            db=db,
            user_id=user_id,
            required_capability=required_capability,
            device_id=device_id,
        )
        if target_device is None:
            raise DeviceSandboxError("No compatible online device is available")

        target_device_id = target_device["device_id"]
        online_info = await device_service.get_device_online_info(
            user_id, target_device_id
        )
        if not online_info:
            raise DeviceSandboxError(f"Device '{target_device_id}' is offline")

        socket_id = online_info.get("socket_id")
        if not socket_id:
            raise DeviceSandboxError(
                f"Device '{target_device_id}' does not have an active socket session"
            )

        sio = get_sio()
        started_at = time.monotonic()

        logger.info(
            "[DeviceSandboxService] Forwarding command to device: user_id=%s, "
            "device_id=%s, working_dir=%s, timeout=%ss, required_capability=%s",
            user_id,
            target_device_id,
            working_dir,
            timeout_seconds,
            required_capability,
        )

        try:
            response = await sio.call(
                "sandbox:exec",
                {
                    "command": command,
                    "working_dir": working_dir,
                    "timeout_seconds": timeout_seconds,
                },
                to=socket_id,
                namespace="/local-executor",
                timeout=max(timeout_seconds + 5, 30),
            )
        except Exception as exc:
            logger.error(
                "[DeviceSandboxService] Device command dispatch failed: user_id=%s, "
                "device_id=%s, error=%s",
                user_id,
                target_device_id,
                exc,
            )
            raise DeviceSandboxError(f"Device command dispatch failed: {exc}") from exc

        if not isinstance(response, dict):
            raise DeviceSandboxError("Device returned an invalid sandbox response")

        execution_time = response.get("execution_time")
        if not isinstance(execution_time, (int, float)):
            execution_time = time.monotonic() - started_at

        exit_code = response.get("exit_code", -1)
        if not isinstance(exit_code, int):
            try:
                exit_code = int(exit_code)
            except (TypeError, ValueError):
                exit_code = -1

        logger.info(
            "[DeviceSandboxService] Device command completed: user_id=%s, device_id=%s, "
            "socket_id=%s, success=%s, exit_code=%s, execution_time=%.2fs, "
            "stdout_len=%s, stderr_len=%s",
            user_id,
            target_device_id,
            socket_id,
            bool(response.get("success", exit_code == 0)),
            exit_code,
            execution_time,
            len(response.get("stdout", "") or ""),
            len(response.get("stderr", "") or ""),
        )

        return {
            "success": bool(response.get("success", exit_code == 0)),
            "stdout": response.get("stdout", "") or "",
            "stderr": response.get("stderr", "") or "",
            "exit_code": exit_code,
            "execution_time": execution_time,
            "device_id": target_device_id,
            "backend": "device",
        }

    async def _select_target_device(
        self,
        db: Session,
        user_id: int,
        required_capability: Optional[str],
        device_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        """Pick an online device for sandbox execution."""
        online_devices = await device_service.get_online_devices(db, user_id)
        if not online_devices:
            return None

        compatible_devices = [
            device
            for device in online_devices
            if self._matches_device(
                device=device,
                required_capability=required_capability,
                device_id=device_id,
            )
        ]
        if not compatible_devices:
            return None

        def priority(device: dict[str, Any]) -> int:
            device_type = device.get("device_type")
            is_default = bool(device.get("is_default"))
            if is_default and device_type == DeviceType.CLOUD.value:
                return 0
            if is_default:
                return 1
            if device_type == DeviceType.CLOUD.value:
                return 2
            return 3

        compatible_devices.sort(key=priority)
        selected_device = compatible_devices[0]
        logger.info(
            "[DeviceSandboxService] Selected device: user_id=%s, device_id=%s, "
            "device_name=%s, device_type=%s, is_default=%s, required_capability=%s, "
            "requested_device_id=%s, capabilities=%s, compatible_candidates=%s",
            user_id,
            selected_device.get("device_id"),
            selected_device.get("device_name"),
            selected_device.get("device_type"),
            selected_device.get("is_default"),
            required_capability,
            device_id,
            selected_device.get("capabilities") or [],
            [
                {
                    "device_id": device.get("device_id"),
                    "device_name": device.get("device_name"),
                    "device_type": device.get("device_type"),
                    "is_default": device.get("is_default"),
                }
                for device in compatible_devices
            ],
        )
        return selected_device

    def _matches_device(
        self,
        device: dict[str, Any],
        required_capability: Optional[str],
        device_id: Optional[str],
    ) -> bool:
        """Check whether a device satisfies routing constraints."""
        if device_id and device.get("device_id") != device_id:
            return False

        if not required_capability:
            return True

        capabilities = device.get("capabilities") or []
        return required_capability in capabilities


device_sandbox_service = DeviceSandboxService()
