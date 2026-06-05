# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project-scoped helpers for starting local device sessions."""

from typing import Literal, Optional

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.project import Project
from app.schemas.device import DeviceType
from app.schemas.project import (
    ProjectConfig,
    ProjectDeviceSessionResponse,
    ProjectExecutionConfig,
)
from app.services.device.session_service import (
    DeviceSessionError,
    DeviceSessionNotFoundError,
    local_device_session_service,
)
from app.services.device_service import device_service

ProjectSessionType = Literal["terminal", "code_server"]


async def start_project_device_session(
    *,
    db: Session,
    user_id: int,
    project_id: int,
    session_type: ProjectSessionType,
    client_origin: Optional[str] = None,
) -> ProjectDeviceSessionResponse:
    """Start an interactive local device session for a workspace project."""
    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    project_config = _parse_project_config(project.config)
    device_id = _get_bound_device_id(project_config)
    _ensure_device_supports_project_sessions(db, user_id, device_id)
    path, create_if_missing = _get_project_path(
        project_config, project.config, project_id
    )

    try:
        result = await local_device_session_service.start_session(
            db=db,
            user_id=user_id,
            device_id=device_id,
            project_id=project_id,
            session_type=session_type,
            path=path,
            create_if_missing=create_if_missing,
        )
    except DeviceSessionNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except DeviceSessionError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    result.setdefault("project_id", project_id)
    result.setdefault("device_id", device_id)
    result.setdefault("type", session_type)
    result.setdefault("path", path)
    return ProjectDeviceSessionResponse.model_validate(result)


def _parse_project_config(config_data: object) -> ProjectConfig:
    try:
        config = ProjectConfig.model_validate(config_data or {})
    except ValidationError as exc:
        if _raw_execution_target(config_data) != "local":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Project must be configured for a bound local device",
            ) from exc
        if _raw_project_path(config_data):
            return ProjectConfig.model_construct(
                mode="workspace",
                execution=ProjectExecutionConfig.model_construct(
                    targetType="local",
                    deviceId=_raw_device_id(config_data),
                ),
                workspace=None,
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid project config: {exc.errors()[0]['msg']}",
        ) from exc

    if not config.is_workspace:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Project must be a workspace project with a bound local device",
        )
    return config


def _get_bound_device_id(config: ProjectConfig) -> str:
    if (
        not config.execution
        or config.execution.targetType != "local"
        or not config.execution.deviceId
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Project must be configured for a bound local device",
        )
    return config.execution.deviceId


def _ensure_device_supports_project_sessions(
    db: Session,
    user_id: int,
    device_id: str,
) -> None:
    """Reject project terminal and code-server sessions for local devices."""

    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        return

    spec = getattr(device_kind, "json", None)
    spec = spec.get("spec", {}) if isinstance(spec, dict) else {}
    device_type = spec.get("deviceType")
    if device_type == DeviceType.LOCAL.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Local devices do not support terminal or code-server sessions",
        )


def _get_project_path(
    config: ProjectConfig,
    raw_config: object,
    project_id: int,
) -> tuple[str, bool]:
    workspace = config.workspace
    if workspace:
        if workspace.source == "git" and workspace.checkoutPath:
            path = f"projects/{workspace.checkoutPath}"
        else:
            path = workspace.localPath or workspace.checkoutPath
        if path:
            return path, True

    path = _raw_project_path(raw_config)
    if path:
        return path, False

    return f"project{project_id}", True


def _raw_device_id(config_data: object) -> str | None:
    if not isinstance(config_data, dict):
        return None
    execution = config_data.get("execution")
    if not isinstance(execution, dict):
        return None
    device_id = execution.get("deviceId") or execution.get("device_id")
    return device_id if isinstance(device_id, str) and device_id.strip() else None


def _raw_project_path(config_data: object) -> str | None:
    if not isinstance(config_data, dict):
        return None

    candidates: list[object] = [
        config_data.get("path"),
        config_data.get("localPath"),
        config_data.get("checkoutPath"),
    ]
    workspace = config_data.get("workspace")
    if isinstance(workspace, dict):
        candidates.extend(
            [
                workspace.get("path"),
                workspace.get("localPath"),
                workspace.get("local_path"),
                workspace.get("checkoutPath"),
                workspace.get("checkout_path"),
            ]
        )

    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _raw_execution_target(config_data: object) -> str | None:
    if not isinstance(config_data, dict):
        return None
    execution = config_data.get("execution")
    if not isinstance(execution, dict):
        return None
    target_type = execution.get("targetType")
    return target_type if isinstance(target_type, str) else None
