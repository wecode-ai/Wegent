# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device API endpoints for querying and managing user's local devices.

Devices are stored as Device CRD in the kinds table.
Online status is managed via Redis with heartbeat mechanism.
"""

import logging
import os
import posixpath
from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.project import Project
from app.models.user import User
from app.schemas.device import (
    DeviceCommandRequest,
    DeviceCommandResponse,
    DeviceInfo,
    DeviceListResponse,
)
from app.schemas.project import ProjectConfig
from app.services.device.command_service import (
    DeviceCommandConfigurationError,
    DeviceCommandError,
    DeviceCommandNotFoundError,
    DeviceCommandUnknownKeyError,
    execute_configured_device_command,
)
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

router = APIRouter()

WORKSPACE_FILE_COMMAND_KEYS = {"workspace_tree", "workspace_read_text_file"}
WORKSPACE_ROOTS_ENV = "WEGENT_WORKSPACE_ROOTS"


# ==================== Request/Response Schemas ====================


class DeviceUpdateAliasRequest(BaseModel):
    """Request model for updating device alias (display name)."""

    alias: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="New display name (alias) for the device",
    )


class DeviceUpgradeRequest(BaseModel):
    """Request model for triggering a device upgrade."""

    force: bool = Field(
        default=False, description="Force upgrade even if already on latest version"
    )
    auto_confirm: bool = Field(
        default=True, description="Skip user confirmation prompts"
    )
    verbose: bool = Field(
        default=False, description="Enable verbose logging during upgrade"
    )
    force_stop_tasks: bool = Field(
        default=False,
        description="Cancel running tasks before upgrade (default: reject if tasks running)",
    )
    registry: Optional[str] = Field(
        default=None, description="Optional: Override registry URL for update source"
    )
    registry_token: Optional[str] = Field(
        default=None, description="Optional: Auth token for private registry"
    )


class DeviceUpgradeResponse(BaseModel):
    """Response model for device upgrade trigger."""

    success: bool = Field(..., description="Whether the upgrade command was sent")
    message: str = Field(..., description="Human-readable status message")


def _normalize_device_path(path: str) -> str:
    normalized = posixpath.normpath(path.strip())
    if normalized == ".":
        return ""
    return normalized.rstrip("/") or "/"


def _is_device_path_within(path: str, root: str) -> bool:
    normalized_path = _normalize_device_path(path)
    normalized_root = _normalize_device_path(root)
    if normalized_root == "/":
        return normalized_path.startswith("/")
    return normalized_path == normalized_root or normalized_path.startswith(
        f"{normalized_root}/"
    )


def _dedupe_paths(paths: list[str]) -> list[str]:
    seen = set()
    deduped = []
    for path in paths:
        normalized = _normalize_device_path(path)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _wework_local_workspace_roots_for_command(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    path: Optional[str],
) -> list[str]:
    if not path:
        return []

    roots = []
    projects = (
        db.query(Project)
        .filter(
            Project.user_id == user_id,
            Project.client_origin == CLIENT_ORIGIN_WEWORK,
            Project.is_active.is_(True),
        )
        .all()
    )
    for project in projects:
        try:
            config = ProjectConfig.model_validate(project.config or {})
        except Exception:
            continue
        if (
            not config.execution
            or not config.workspace
            or config.workspace.source != "local_path"
            or config.execution.deviceId != device_id
            or not config.workspace.localPath
        ):
            continue
        root = _normalize_device_path(config.workspace.localPath)
        if _is_device_path_within(path, root):
            roots.append(root)

    return _dedupe_paths(roots)


def _device_command_env(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    request: DeviceCommandRequest,
) -> dict[str, str]:
    env = dict(request.env)
    if request.command_key not in WORKSPACE_FILE_COMMAND_KEYS:
        return env

    env.pop(WORKSPACE_ROOTS_ENV, None)
    roots = _wework_local_workspace_roots_for_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        path=request.path or request.cwd,
    )
    if roots:
        env[WORKSPACE_ROOTS_ENV] = os.pathsep.join(roots)
    return env


@router.get("", response_model=DeviceListResponse)
async def get_all_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all devices for the current user (including offline).

    Returns all registered devices with their current online status.
    Devices auto-register via WebSocket when they connect.

    Returns:
        DeviceListResponse with all devices list
    """
    devices = await device_service.get_all_devices(db, current_user.id)
    return DeviceListResponse(
        items=[DeviceInfo(**d) for d in devices],
        total=len(devices),
    )


@router.get("/online", response_model=DeviceListResponse)
async def get_online_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get only online devices for the current user.

    Queries Redis for online device status and returns the list.
    This endpoint is for backward compatibility.

    Returns:
        DeviceListResponse with online devices list
    """
    devices = await device_service.get_online_devices(db, current_user.id)
    return DeviceListResponse(
        items=[DeviceInfo(**d) for d in devices],
        total=len(devices),
    )


@router.put("/{device_id}/default")
async def set_default_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Set a device as the default executor.

    Only one device can be default at a time.
    Setting a new default will clear the previous default.

    Args:
        device_id: Device unique identifier

    Returns:
        Success message

    Raises:
        HTTPException 404: If device not found
    """
    success = device_service.set_device_as_default(db, current_user.id, device_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device '{device_id}' not found",
        )
    return {"message": f"Device '{device_id}' set as default"}


@router.delete("/{device_id}")
async def delete_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a device registration.

    Note: If the device reconnects via WebSocket, it will be re-registered.

    Args:
        device_id: Device unique identifier

    Returns:
        Success message

    Raises:
        HTTPException 404: If device not found
    """
    success = device_service.delete_device(db, current_user.id, device_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device '{device_id}' not found",
        )
    return {"message": f"Device '{device_id}' deleted"}


@router.put("/{device_id}/alias")
async def update_device_alias(
    device_id: str,
    request: DeviceUpdateAliasRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a device's display name (alias).

    The alias is used for display purposes in the UI and does not affect
    the device's unique identifier (device_id).

    Args:
        device_id: Device unique identifier
        request: Request containing the new alias

    Returns:
        Success message with the new alias

    Raises:
        HTTPException 404: If device not found
    """
    success = device_service.update_device_alias(
        db, current_user.id, device_id, request.alias
    )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device '{device_id}' not found",
        )
    logger.info(
        f"[Device Alias] Updated alias: user_id={current_user.id}, "
        f"device_id={device_id}, alias={request.alias}"
    )
    return {
        "message": f"Device alias updated to '{request.alias}'",
        "alias": request.alias,
    }


@router.post("/{device_id}/upgrade", response_model=DeviceUpgradeResponse)
async def trigger_device_upgrade(
    device_id: str,
    request: DeviceUpgradeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DeviceUpgradeResponse:
    """
    Trigger a remote upgrade for a device.

    This endpoint sends an upgrade command to the specified device via WebSocket.
    The device must be online and owned by the current user.

    Args:
        device_id: The unique device identifier
        request: Upgrade configuration options
        db: Database session
        current_user: Authenticated user

    Returns:
        DeviceUpgradeResponse indicating success/failure

    Raises:
        HTTPException 404: If device not found or access denied
        HTTPException 400: If device is offline or has running tasks
    """
    user_id = current_user.id

    # Check if device exists and user owns it
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        logger.warning(
            f"[Device Upgrade] Device not found or access denied: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found or access denied",
        )

    # Get device status from provider (includes Redis online status and running tasks)
    from app.schemas.device import DeviceType
    from app.services.device.provider_factory import DeviceProviderFactory

    device_type_str = device_kind.json.get("spec", {}).get(
        "deviceType", DeviceType.LOCAL.value
    )
    device_type = DeviceType(device_type_str)
    provider = DeviceProviderFactory.get_provider(device_type)
    if provider is None:
        logger.error(
            f"[Device Upgrade] No provider found for device type: {device_type}, "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No provider available for device type: {device_type}",
        )
    device_info = await provider.get_status(db, user_id, device_id)

    # Check if device is online
    if device_info.get("status") != "online":
        logger.warning(
            f"[Device Upgrade] Device is offline: "
            f"user_id={user_id}, device_id={device_id}, status={device_info.get('status')}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Device is offline"
        )

    # Check if device has running tasks
    running_tasks = device_info.get("running_tasks", [])
    if running_tasks and not request.force_stop_tasks:
        logger.warning(
            f"[Device Upgrade] Device has {len(running_tasks)} running tasks: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Device has {len(running_tasks)} running task(s). "
            f"Wait for tasks to complete or use force_stop_tasks=true",
        )

    # Get socket_id from Redis
    online_info = await device_service.get_device_online_info(user_id, device_id)
    if not online_info:
        logger.error(
            f"[Device Upgrade] Device online info not found in Redis: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device online information not found",
        )

    socket_id = online_info.get("socket_id")
    if not socket_id:
        logger.error(
            f"[Device Upgrade] Device socket_id not found: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device socket information not found",
        )

    # Emit upgrade command via WebSocket
    try:
        from app.api.ws.device_namespace import device_namespace

        upgrade_params = {
            "force": request.force,
            "auto_confirm": request.auto_confirm,
            "verbose": request.verbose,
            "force_stop_tasks": request.force_stop_tasks,
            "registry": request.registry,
            "registry_token": request.registry_token,
        }

        success = await device_namespace.emit_upgrade_command(socket_id, upgrade_params)

        if success:
            logger.info(
                f"[Device Upgrade] Upgrade command sent: "
                f"user_id={user_id}, device_id={device_id}, socket_id={socket_id}"
            )
            return DeviceUpgradeResponse(
                success=True, message="Upgrade command sent to device"
            )
        else:
            logger.error(
                f"[Device Upgrade] Failed to emit upgrade command: "
                f"user_id={user_id}, device_id={device_id}"
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to send upgrade command to device",
            )

    except Exception as e:
        logger.exception(
            f"[Device Upgrade] Error triggering upgrade: "
            f"user_id={user_id}, device_id={device_id}, error={e}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to trigger upgrade: {str(e)}",
        )


@router.post("/{device_id}/commands", response_model=DeviceCommandResponse)
async def execute_device_command(
    device_id: str,
    request: DeviceCommandRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DeviceCommandResponse:
    """
    Execute a shell command on an online local executor device.

    The backend sends a Socket.IO RPC to the target local executor and waits for
    the completed process result.
    """
    user_id = current_user.id
    try:
        result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key=request.command_key,
            path=request.path or request.cwd,
            args=request.args,
            env=_device_command_env(
                db=db,
                user_id=user_id,
                device_id=device_id,
                request=request,
            ),
            timeout_seconds=request.timeout_seconds,
            max_output_bytes=request.max_output_bytes,
        )
    except DeviceCommandNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        )
    except DeviceCommandUnknownKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )
    except DeviceCommandConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )
    except DeviceCommandError as exc:
        logger.warning(
            "[Device Command] Command RPC failed: user_id=%s, device_id=%s, error=%s",
            user_id,
            device_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    logger.info(
        "[Device Command] Command completed: user_id=%s, device_id=%s, "
        "exit_code=%s, duration=%s",
        user_id,
        device_id,
        result.get("exit_code"),
        result.get("duration"),
    )
    return DeviceCommandResponse(**result)


# ==================== Device Session Endpoints ====================

DEFAULT_DEVICE_SESSION_PATH = "/home/ubuntu/.wegent-executor/workspace"


class DeviceSessionResponse(BaseModel):
    """Response model for device session creation."""

    session_id: str = Field(..., description="Unique session identifier")
    device_id: str = Field(..., description="Target device ID")
    type: Literal["terminal", "code_server"] = Field(
        ...,
        description="Session type",
    )
    path: str = Field(..., description="Working directory path")
    url: str = Field(default="", description="Browser-accessible session URL")
    transport: Literal["url", "socketio"] = Field(
        default="url",
        description="Browser transport for the interactive session",
    )


class DeviceSessionCreate(BaseModel):
    """Request model for device session creation."""

    path: Optional[str] = Field(
        default=None,
        description="Optional working directory path",
    )


@router.post("/{device_id}/terminal", response_model=DeviceSessionResponse)
async def start_device_terminal(
    device_id: str,
    payload: DeviceSessionCreate | None = Body(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Start a terminal session on a device.

    Sends a Socket.IO RPC to the online device executor to start an embedded
    PTY session. Requires the device to be online.
    """
    from app.services.device.session_service import (
        DeviceSessionError,
        local_device_session_service,
    )

    requested_path = payload.path.strip() if payload and payload.path else ""
    session_path = requested_path or DEFAULT_DEVICE_SESSION_PATH
    try:
        result = await local_device_session_service.start_session(
            db=db,
            user_id=current_user.id,
            device_id=device_id,
            project_id=0,
            session_type="terminal",
            path=session_path,
            create_if_missing=not bool(requested_path),
        )
    except DeviceSessionError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    return DeviceSessionResponse(
        session_id=result.get("session_id", ""),
        device_id=result.get("device_id", device_id),
        type="terminal",
        path=result.get("path", session_path),
        url=result.get("url", ""),
        transport=result.get("transport", "socketio"),
    )


@router.post("/{device_id}/code-server", response_model=DeviceSessionResponse)
async def start_device_code_server(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Start a code-server (IDE) session on a device.

    Sends a Socket.IO RPC to the online device executor to start a
    code-server session. Requires the device to be online.
    """
    from app.services.device.session_service import (
        DeviceSessionError,
        local_device_session_service,
    )

    try:
        result = await local_device_session_service.start_session(
            db=db,
            user_id=current_user.id,
            device_id=device_id,
            project_id=0,
            session_type="code_server",
            path=DEFAULT_DEVICE_SESSION_PATH,
            create_if_missing=True,
        )
    except DeviceSessionError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    return DeviceSessionResponse(
        session_id=result.get("session_id", ""),
        device_id=result.get("device_id", device_id),
        type="code_server",
        path=result.get("path", DEFAULT_DEVICE_SESSION_PATH),
        url=result.get("url", ""),
        transport=result.get("transport", "url"),
    )
