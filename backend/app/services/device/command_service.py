# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend RPC service for executing commands on local devices."""

import logging
from pathlib import PurePosixPath, PureWindowsPath
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
    LocalDeviceCommandDefinition,
    build_local_device_command_argv,
    register_local_device_command,
    resolve_local_device_command,
)
from app.services.device.remote_control_policy import (
    REMOTE_CONTROL_DISABLED_MESSAGE,
    device_kind_type,
    remote_control_is_enabled,
)
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

DEFAULT_COMMAND_TIMEOUT_SECONDS = 60
MAX_COMMAND_TIMEOUT_SECONDS = 600
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 5 * 1024 * 1024
SOCKET_ACK_GRACE_SECONDS = 5
REMOTE_READ_ONLY_COMMAND_KEYS = frozenset(
    {
        "pwd",
        "home_dir",
        "ls_dirs",
        "workspace_tree",
        "workspace_read_text_file",
        "workspace_read_file_chunk",
        "git_branch",
        "git_branch_list",
        "git_diff",
        "git_branch_diff",
        "git_diff_unstaged",
        "git_diff_staged",
        "git_diff_last_commit",
        "git_branch_diff_shortstat",
        "git_status_porcelain",
        "git_remote_url",
        "git_github_cli_status",
        "git_gitlab_cli_status",
        "git_github_pull_requests",
        "git_github_pull_requests_batch",
        "git_github_pull_request_merge_queue_batch",
        "git_gitlab_merge_requests",
        "git_gitlab_merge_requests_batch",
        "turn_file_changes_review",
    }
)
REMOTE_MUTATING_COMMAND_KEYS = frozenset(
    {
        "mkdir_p",
        "git_clone",
        "git_checkout",
        "git_checkout_new",
        "git_add_all",
        "git_apply_patch",
        "git_commit",
        "git_push",
        "sync_git_credentials",
        "turn_file_changes_revert",
        "environment_prepare",
    }
)
RUNTIME_AUTH_COMMAND_KEYS = frozenset(
    {"read_runtime_auth_file", "sync_runtime_auth_file"}
)
REMOTE_DEVICE_COMMAND_KEYS = (
    REMOTE_READ_ONLY_COMMAND_KEYS
    | REMOTE_MUTATING_COMMAND_KEYS
    | RUNTIME_AUTH_COMMAND_KEYS
)
LOCAL_COMMAND_DEVICE_TYPES = frozenset({DeviceType.LOCAL, DeviceType.APP})
INTERNAL_DEVICE_COMMAND_KEYS = frozenset(
    {"environment_prepare", "sync_git_credentials"}
)
_registered_command_scopes: dict[str, frozenset[DeviceType]] = {}


def _git_command_failure(result: Mapping[str, Any]) -> str:
    """Classify Git failures without recording URLs, credentials, or raw output."""
    if result.get("timed_out"):
        return "timeout"
    if result.get("success") and result.get("exit_code") == 0:
        return "none"
    output = str(result.get("stderr") or result.get("error") or "").lower()
    for failure, needles in (
        ("target_not_empty", ("already exists and is not an empty directory",)),
        (
            "authentication",
            (
                "authentication failed",
                "could not read username",
                "permission denied (publickey)",
            ),
        ),
        ("repository_not_found", ("repository not found",)),
        ("branch_not_found", ("not found in upstream origin",)),
        ("host_key", ("host key verification failed",)),
        (
            "network",
            (
                "could not resolve",
                "connection refused",
                "unable to access",
                "failed to connect",
            ),
        ),
        ("not_repository", ("not a git repository",)),
        ("path_permissions", ("permission denied", "operation not permitted")),
        ("path_missing", ("no such file or directory",)),
    ):
        if any(needle in output for needle in needles):
            return failure
    return "git_error"


def _command_log_path(value: Any) -> str | None:
    """Only log absolute paths; command operands may be credential-bearing URLs."""
    if not isinstance(value, str) or "://" in value:
        return None
    if PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute():
        return value
    return None


def register_device_command(
    key: str,
    definition: LocalDeviceCommandDefinition,
    *,
    allowed_device_types: frozenset[DeviceType],
) -> None:
    """Register a trusted distribution command and its device-type policy."""
    if not allowed_device_types or key in _registered_command_scopes:
        raise ValueError(f"Invalid device command registration: {key}")
    register_local_device_command(key, definition)
    _registered_command_scopes[key] = allowed_device_types


class DeviceCommandError(RuntimeError):
    """Raised when a local device command cannot be dispatched or completed."""


class DeviceCommandNotFoundError(DeviceCommandError):
    """Raised when a local device does not exist or is not owned by the user."""


class DeviceCommandUnknownKeyError(DeviceCommandError):
    """Raised when a configured command key cannot be resolved."""


class DeviceCommandConfigurationError(DeviceCommandError):
    """Raised when configured command metadata is invalid."""


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
    allow_app_device: bool,
) -> str:
    if device_type is None:
        raise DeviceCommandError(
            "Device command RPC is not supported for unknown device type"
        )

    if not allow_app_device and not remote_control_is_enabled(device_type):
        raise DeviceCommandError(REMOTE_CONTROL_DISABLED_MESSAGE)

    scope = _registered_command_scopes.get(command_key)
    if scope is not None and device_type not in scope:
        raise DeviceCommandError(
            f"Device command key '{command_key}' is not supported for "
            f"{device_type.value} devices"
        )

    if device_type in LOCAL_COMMAND_DEVICE_TYPES:
        if device_type == DeviceType.APP:
            from app.services.device.identity import record_route_id

            return record_route_id(device_kind)
        return submitted_device_id

    if device_type not in {DeviceType.CLOUD, DeviceType.REMOTE}:
        raise DeviceCommandError(
            f"Device command RPC is not supported for {device_type.value} devices"
        )

    allowed_keys = REMOTE_DEVICE_COMMAND_KEYS | {
        key for key, types in _registered_command_scopes.items() if device_type in types
    }
    if command_key not in allowed_keys:
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
        command_key: Optional[str] = None,
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
        if command_key:
            payload["command_key"] = command_key

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
        if command in {"git clone", "git remote get-url origin"}:
            logger.info(
                "Git command RPC completed: device_id=%s command=%s cwd=%r "
                "target=%r success=%s exit_code=%s failure=%s duration=%s",
                device_id,
                command,
                _command_log_path(path or cwd),
                (
                    _command_log_path(args[-1])
                    if command == "git clone" and args and len(args) >= 2
                    else None
                ),
                result.get("success"),
                result.get("exit_code"),
                _git_command_failure(result),
                result.get("duration"),
            )
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


def is_builtin_native_git_command(
    command_key: str, configured_commands: Mapping[str, Any]
) -> bool:
    """Identify native Git commands while preserving explicit overrides."""
    return (
        command_key in {"git_branch", "git_branch_list", "git_clone"}
        and command_key not in configured_commands
    )


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
    allow_internal: bool = False,
    allow_app_device: bool = True,
) -> dict[str, Any]:
    """Execute a configured local device command for internal Backend callers."""
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise DeviceCommandNotFoundError("Device not found or access denied")
    device_type = device_kind_type(device_kind)

    if command_key in INTERNAL_DEVICE_COMMAND_KEYS and not allow_internal:
        raise DeviceCommandUnknownKeyError(
            f"Device command key '{command_key}' is not available through the command API"
        )

    configured_commands = (
        settings.LOCAL_DEVICE_COMMANDS if command_config is None else command_config
    )
    try:
        command_definition = resolve_local_device_command(
            command_key, configured_commands
        )
    except CommandRegistryError as exc:
        raise DeviceCommandConfigurationError(str(exc)) from exc

    if command_definition is None:
        raise DeviceCommandUnknownKeyError(
            f"Device command key '{command_key}' is not configured"
        )

    uses_native_git_command = is_builtin_native_git_command(
        command_key, configured_commands
    )
    dispatch_device_id = await _resolve_dispatch_device_id(
        user_id=user_id,
        submitted_device_id=device_id,
        command_key=command_key,
        device_kind=device_kind,
        device_type=device_type,
        allow_app_device=allow_app_device,
    )

    execute_kwargs = {
        "user_id": user_id,
        "device_id": dispatch_device_id,
        "command": command_definition.command,
        "path": path,
        "args": args or [],
        "env": env or {},
        "timeout_seconds": timeout_seconds,
        "max_output_bytes": max_output_bytes,
    }
    if uses_native_git_command or command_key in {
        "environment_prepare",
        "git_apply_patch",
        "workspace_tree",
        "workspace_read_text_file",
        "workspace_read_file_chunk",
    }:
        execute_kwargs["command_key"] = command_key
    result = await local_device_command_service.execute_command(**execute_kwargs)

    try:
        return apply_command_post_processor(
            result,
            command_definition.post_processor,
        )
    except CommandPostProcessorError as exc:
        raise DeviceCommandConfigurationError(str(exc)) from exc
