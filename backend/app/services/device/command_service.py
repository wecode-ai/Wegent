# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend RPC service for executing commands on local devices."""

import logging
from typing import Any, Mapping, Optional

from socketio.exceptions import (
    BadNamespaceError,
    DisconnectedError,
)
from socketio.exceptions import TimeoutError as SocketTimeoutError

from app.core.config import settings
from app.core.socketio import get_sio
from app.schemas.device import DeviceType
from app.services.device.command_post_processor import (
    CommandPostProcessorError,
    apply_command_post_processor,
)
from app.services.device.command_registry import (
    CommandRegistryError,
    build_local_device_command_argv,
    resolve_local_device_command,
)
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

DEFAULT_COMMAND_TIMEOUT_SECONDS = 60
MAX_COMMAND_TIMEOUT_SECONDS = 600
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 5 * 1024 * 1024
SOCKET_ACK_GRACE_SECONDS = 5
REMOTE_DIRECTORY_COMMAND_KEYS = frozenset({"pwd", "ls_dirs"})
LOCAL_COMMAND_DEVICE_TYPES = frozenset({DeviceType.LOCAL, DeviceType.APP})


class DeviceCommandError(RuntimeError):
    """Raised when a local device command cannot be dispatched or completed."""


class DeviceCommandNotFoundError(DeviceCommandError):
    """Raised when a local device does not exist or is not owned by the user."""


class DeviceCommandUnknownKeyError(DeviceCommandError):
    """Raised when a configured command key cannot be resolved."""


class DeviceCommandConfigurationError(DeviceCommandError):
    """Raised when configured command metadata is invalid."""


def _device_kind_type(device_kind: Any) -> Optional[DeviceType]:
    spec = getattr(device_kind, "json", None)
    spec = spec.get("spec", {}) if isinstance(spec, dict) else {}
    if "deviceType" not in spec:
        return DeviceType.LOCAL
    device_type = spec.get("deviceType")
    if not isinstance(device_type, str):
        return None
    try:
        return DeviceType(device_type)
    except ValueError:
        return None


def _resolve_cloud_runtime_device_id(device_kind: Any) -> str:
    spec = getattr(device_kind, "json", None)
    spec = spec.get("spec", {}) if isinstance(spec, dict) else {}
    cloud_config = spec.get("cloudConfig") or {}
    if not isinstance(cloud_config, dict):
        cloud_config = {}
    return (
        spec.get("deviceId")
        or cloud_config.get("deviceId")
        or getattr(device_kind, "name", "")
    )


async def _resolve_dispatch_device_id(
    *,
    user_id: int,
    submitted_device_id: str,
    command_key: str,
    device_kind: Any,
    device_type: Optional[DeviceType],
) -> str:
    if device_type is None:
        raise DeviceCommandError(
            "Device command RPC is not supported for unknown device type"
        )

    if device_type in LOCAL_COMMAND_DEVICE_TYPES:
        return submitted_device_id

    if device_type not in {DeviceType.CLOUD, DeviceType.REMOTE}:
        raise DeviceCommandError(
            f"Device command RPC is not supported for {device_type.value} devices"
        )

    if command_key not in REMOTE_DIRECTORY_COMMAND_KEYS:
        raise DeviceCommandError(
            f"Device command key '{command_key}' is not supported for "
            f"{device_type.value} devices"
        )

    dispatch_device_id = (
        _resolve_cloud_runtime_device_id(device_kind)
        if device_type == DeviceType.CLOUD
        else submitted_device_id
    )
    if not dispatch_device_id:
        raise DeviceCommandError(
            f"{device_type.value.title()} device '{submitted_device_id}' is unavailable"
        )

    online_info = await device_service.get_device_online_info_by_type(
        user_id,
        dispatch_device_id,
        device_type,
    )
    if not online_info:
        raise DeviceCommandError(
            f"{device_type.value.title()} device '{submitted_device_id}' is offline "
            "or unavailable"
        )

    return dispatch_device_id


class LocalDeviceCommandService:
    """Send command RPC requests to connected local executor devices."""

    @staticmethod
    def is_unavailable_error(exc: Exception) -> bool:
        """Return whether an RPC error means the local device is unavailable."""

        detail = str(exc).lower()
        return "offline" in detail or "disconnected" in detail or "no socket" in detail

    async def execute_command(
        self,
        user_id: int,
        device_id: str,
        command: str,
        path: Optional[str] = None,
        args: Optional[list[str]] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, Any]] = None,
        timeout_seconds: int = DEFAULT_COMMAND_TIMEOUT_SECONDS,
        max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    ) -> dict[str, Any]:
        """Execute a command on an online local device and wait for the result."""
        normalized_timeout = self._clamp_positive_int(
            timeout_seconds,
            default=DEFAULT_COMMAND_TIMEOUT_SECONDS,
            upper_bound=MAX_COMMAND_TIMEOUT_SECONDS,
        )
        normalized_max_output = self._clamp_positive_int(
            max_output_bytes,
            default=DEFAULT_MAX_OUTPUT_BYTES,
            upper_bound=MAX_OUTPUT_BYTES,
        )

        online_info = await device_service.get_device_online_info(user_id, device_id)
        if not online_info:
            raise DeviceCommandError(f"Device '{device_id}' is offline")

        socket_id = online_info.get("socket_id")
        if not socket_id:
            raise DeviceCommandError(f"Device '{device_id}' has no socket information")

        payload = {
            "command": command,
            "cwd": path or cwd,
            "args": args or [],
            "argv": build_local_device_command_argv(command, args or []),
            "env": env or {},
            "timeout_seconds": normalized_timeout,
            "max_output_bytes": normalized_max_output,
        }

        logger.info(
            "[LocalDeviceCommandService] Sending command RPC: "
            "user_id=%s, device_id=%s, socket_id=%s, timeout=%s, command=%s",
            user_id,
            device_id,
            socket_id,
            normalized_timeout,
            command[:200],
        )

        sio = get_sio()
        try:
            result = await sio.call(
                "device:execute_command",
                payload,
                to=socket_id,
                namespace="/local-executor",
                timeout=normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            )
        except Exception as exc:
            message = self._format_rpc_error(
                exc,
                device_id=device_id,
                event="device:execute_command",
                timeout_seconds=normalized_timeout + SOCKET_ACK_GRACE_SECONDS,
            )
            raise DeviceCommandError(message) from exc

        if not isinstance(result, dict):
            raise DeviceCommandError("Command RPC returned an invalid response")
        return result

    def _clamp_positive_int(
        self,
        value: Any,
        default: int,
        upper_bound: int,
    ) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        if parsed <= 0:
            return default
        return min(parsed, upper_bound)

    def _format_rpc_error(
        self,
        exc: Exception,
        *,
        device_id: str,
        event: str,
        timeout_seconds: int,
    ) -> str:
        if isinstance(exc, SocketTimeoutError):
            return (
                f"Command RPC timed out after {timeout_seconds} seconds while "
                f"waiting for device '{device_id}' to acknowledge {event}. "
                "Reconnect or upgrade the local executor and retry."
            )
        if isinstance(exc, DisconnectedError):
            return (
                f"Command RPC failed because device '{device_id}' disconnected "
                f"before acknowledging {event}."
            )
        if isinstance(exc, BadNamespaceError):
            return (
                f"Command RPC failed because the local executor is not connected "
                f"to the /local-executor namespace for device '{device_id}'."
            )

        detail = str(exc).strip() or exc.__class__.__name__
        return f"Command RPC failed: {detail}"


local_device_command_service = LocalDeviceCommandService()


async def execute_configured_device_command(
    *,
    db: Any,
    user_id: int,
    device_id: str,
    command_key: str,
    path: Optional[str] = None,
    args: Optional[list[str]] = None,
    env: Optional[dict[str, Any]] = None,
    timeout_seconds: int = DEFAULT_COMMAND_TIMEOUT_SECONDS,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    command_config: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Execute a configured local device command for internal Backend callers."""
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise DeviceCommandNotFoundError("Device not found or access denied")
    device_type = _device_kind_type(device_kind)

    try:
        command_definition = resolve_local_device_command(
            command_key,
            (
                settings.LOCAL_DEVICE_COMMANDS
                if command_config is None
                else command_config
            ),
        )
    except CommandRegistryError as exc:
        raise DeviceCommandConfigurationError(str(exc)) from exc

    if command_definition is None:
        raise DeviceCommandUnknownKeyError(
            f"Device command key '{command_key}' is not configured"
        )

    dispatch_device_id = await _resolve_dispatch_device_id(
        user_id=user_id,
        submitted_device_id=device_id,
        command_key=command_key,
        device_kind=device_kind,
        device_type=device_type,
    )

    result = await local_device_command_service.execute_command(
        user_id=user_id,
        device_id=dispatch_device_id,
        command=command_definition.command,
        path=path,
        args=args or [],
        env=env or {},
        timeout_seconds=timeout_seconds,
        max_output_bytes=max_output_bytes,
    )

    try:
        return apply_command_post_processor(
            result,
            command_definition.post_processor,
        )
    except CommandPostProcessorError as exc:
        raise DeviceCommandConfigurationError(str(exc)) from exc
