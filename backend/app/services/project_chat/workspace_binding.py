# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Canonical workspace binding storage and legacy adaptation for robots."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.delivery import ProjectChatAgent
from app.models.project import Project
from app.schemas.project_chat import (
    ProjectChatWorkspaceBinding,
    ProjectChatWorkspaceBindingView,
)
from app.services.runtime_work_kind_store import (
    get_device_workspace_kind_by_id,
    list_device_workspace_kinds,
)

WORKSPACE_BINDING_METADATA_KEY = "workspace_binding"


def normalize_workspace_binding(
    db: Session,
    *,
    user_id: int,
    environment: str,
    execution_device_id: str,
    binding: ProjectChatWorkspaceBinding,
) -> ProjectChatWorkspaceBindingView:
    """Validate stable workspace intent against its owner and target device."""

    if binding.type == "standalone":
        return ProjectChatWorkspaceBindingView(type="standalone", status="ready")

    if binding.device_id and binding.device_id != execution_device_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Workspace binding does not belong to the execution device",
        )
    if binding.type == "device_project":
        return ProjectChatWorkspaceBindingView(
            type="device_project",
            status="ready",
            deviceId=execution_device_id,
            runtimeProjectKey=binding.runtime_project_key,
        )

    project = _owned_project(db, user_id=user_id, project_id=binding.project_id or 0)
    device_workspace_id = binding.device_workspace_id
    if device_workspace_id is not None:
        mapping = get_device_workspace_kind_by_id(
            db=db,
            user_id=user_id,
            workspace_id=device_workspace_id,
        )
        if mapping is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Device workspace not found",
            )
        if mapping.project_id != project.id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Device workspace does not belong to the bound project",
            )
        if mapping.device_id != execution_device_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Device workspace does not belong to the execution device",
            )
    elif environment == "cloud":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Cloud robot workspace binding requires deviceWorkspaceId",
        )

    return ProjectChatWorkspaceBindingView(
        type="backend_project",
        status="ready",
        projectId=project.id,
        deviceWorkspaceId=device_workspace_id,
        deviceId=execution_device_id,
    )


def adapt_legacy_workspace_binding(
    db: Session,
    *,
    user_id: int,
    environment: str,
    execution_device_id: str,
    local_project_id: int | None,
) -> ProjectChatWorkspaceBindingView:
    """Convert the historical Backend Project id without guessing a cloud path."""

    project_id = int(local_project_id or 0)
    if project_id <= 0:
        return ProjectChatWorkspaceBindingView(type="standalone", status="ready")
    _owned_project(db, user_id=user_id, project_id=project_id)
    if environment != "cloud":
        return ProjectChatWorkspaceBindingView(
            type="backend_project",
            status="ready",
            projectId=project_id,
            deviceId=execution_device_id,
        )

    candidates = [
        mapping
        for mapping in list_device_workspace_kinds(
            db=db,
            user_id=user_id,
            project_ids=[project_id],
        )
        if mapping.device_id == execution_device_id
    ]
    if len(candidates) != 1:
        return ProjectChatWorkspaceBindingView(
            type="legacy_project",
            status="needs_rebind",
            projectId=project_id,
            deviceId=execution_device_id,
        )
    return ProjectChatWorkspaceBindingView(
        type="backend_project",
        status="ready",
        projectId=project_id,
        deviceWorkspaceId=candidates[0].id,
        deviceId=execution_device_id,
    )


def read_agent_workspace_binding(
    db: Session,
    *,
    agent: ProjectChatAgent,
) -> ProjectChatWorkspaceBindingView:
    """Read V2 JSON first, then adapt one historical row at the boundary."""

    metadata = agent.metadata_json if isinstance(agent.metadata_json, dict) else {}
    raw_binding = metadata.get(WORKSPACE_BINDING_METADATA_KEY)
    if isinstance(raw_binding, dict):
        try:
            stored = ProjectChatWorkspaceBinding.model_validate(raw_binding)
            return normalize_workspace_binding(
                db,
                user_id=int(agent.created_by_user_id or 0),
                environment=str(metadata.get("execution_environment") or "local"),
                execution_device_id=str(agent.device_id or ""),
                binding=stored,
            )
        except (HTTPException, ValueError):
            return _unresolved_workspace_binding(raw_binding, agent)
    return adapt_legacy_workspace_binding(
        db,
        user_id=int(agent.created_by_user_id or 0),
        environment=str(metadata.get("execution_environment") or "local"),
        execution_device_id=str(agent.device_id or ""),
        local_project_id=agent.local_project_id,
    )


def write_workspace_binding(
    metadata: dict[str, Any],
    binding: ProjectChatWorkspaceBindingView,
) -> dict[str, Any]:
    """Return metadata with one normalized V2 workspace binding."""

    updated = dict(metadata)
    updated[WORKSPACE_BINDING_METADATA_KEY] = binding.model_dump(
        by_alias=True,
        exclude={"status"},
        exclude_none=True,
    )
    return updated


def _owned_project(db: Session, *, user_id: int, project_id: int) -> Project:
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.client_origin == CLIENT_ORIGIN_WEWORK,
            Project.is_active,
        )
        .first()
    )
    if project is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Bound project not found",
        )
    return project


def _unresolved_workspace_binding(
    raw_binding: dict[str, Any],
    agent: ProjectChatAgent,
) -> ProjectChatWorkspaceBindingView:
    binding_type = str(raw_binding.get("type") or "")
    project_id = raw_binding.get("projectId")
    if binding_type == "backend_project" and isinstance(project_id, int):
        return ProjectChatWorkspaceBindingView(
            type="backend_project",
            status="needs_rebind",
            projectId=project_id,
            deviceWorkspaceId=(
                raw_binding.get("deviceWorkspaceId")
                if isinstance(raw_binding.get("deviceWorkspaceId"), int)
                else None
            ),
            deviceId=str(agent.device_id or "") or None,
        )
    if binding_type == "device_project":
        runtime_project_key = raw_binding.get("runtimeProjectKey")
        return ProjectChatWorkspaceBindingView(
            type="device_project",
            status="needs_rebind",
            deviceId=str(agent.device_id or ""),
            runtimeProjectKey=(
                runtime_project_key
                if isinstance(runtime_project_key, str) and runtime_project_key
                else "invalid"
            ),
        )
    return ProjectChatWorkspaceBindingView(
        type="standalone",
        status="needs_rebind",
    )
