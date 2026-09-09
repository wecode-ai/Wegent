# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve the local execution device for chat task dispatch."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.project import Project
from app.models.task import TaskResource
from app.schemas.device import DeviceType
from app.services.device.runtime_route import resolve_runtime_route_identity

if TYPE_CHECKING:
    from app.services.chat.storage.task_manager import TaskCreationParams


def resolve_chat_task_device_id(
    db: Session,
    *,
    user_id: int,
    params: "TaskCreationParams",
    task: TaskResource | None = None,
) -> str | None:
    """Resolve the immutable device target used to dispatch a chat task."""

    if task is not None:
        if extract_task_type(task) == "code":
            return None
        task_device_id = extract_task_device_id(task)
        if not task_device_id:
            return None
        return resolve_local_executor_device_id(
            db,
            user_id=user_id,
            device_id=task_device_id,
        )

    explicit_device_id = _clean_string(params.device_id)
    if explicit_device_id:
        return resolve_local_executor_device_id(
            db,
            user_id=user_id,
            device_id=explicit_device_id,
        )

    project_id = params.project_id or 0
    client_origin = params.client_origin
    project_device_id = _extract_project_device_id(
        db,
        user_id=user_id,
        project_id=project_id,
        client_origin=client_origin,
    )
    if project_device_id:
        return resolve_local_executor_device_id(
            db,
            user_id=user_id,
            device_id=project_device_id,
        )

    return None


def resolve_local_executor_device_id(
    db: Session,
    *,
    user_id: int,
    device_id: str | None,
) -> str | None:
    """Resolve app IPC device identifiers to the executor Socket.IO device id."""

    candidate = _clean_string(device_id)
    if not candidate:
        return None

    identity = resolve_runtime_route_identity(
        db, user_id=user_id, submitted_device_id=candidate
    )
    if identity and identity.device_type == DeviceType.APP:
        return identity.runtime_device_id

    devices = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .all()
    )

    for device in devices:
        if device.name == candidate:
            if (
                device.json.get("spec", {}).get("deviceType") == "app"
                and identity is None
            ):
                raise HTTPException(
                    409,
                    "Ambiguous historical device; select a specific Wework installation",
                )
            return candidate

    for device in devices:
        device_json = device.json if isinstance(device.json, dict) else {}
        spec = device_json.get("spec")
        if not isinstance(spec, dict):
            continue
        if _clean_string(spec.get("appDeviceId")) == candidate:
            if spec.get("deviceType") == "app":
                raise HTTPException(
                    409,
                    "Ambiguous historical device; select a specific Wework installation",
                )
            return _clean_string(device.name) or candidate

    return candidate


def extract_task_device_id(task: TaskResource | None) -> str | None:
    """Extract a task-level device id from Task spec."""

    task_json = getattr(task, "json", None)
    if not isinstance(task_json, dict):
        return None
    spec = task_json.get("spec")
    if not isinstance(spec, dict):
        return None
    return _clean_string(spec.get("device_id"))


def extract_task_type(task: TaskResource | None) -> str | None:
    """Extract the persisted task type label."""

    task_json = getattr(task, "json", None)
    if not isinstance(task_json, dict):
        return None
    metadata = task_json.get("metadata")
    if not isinstance(metadata, dict):
        return None
    labels = metadata.get("labels")
    if not isinstance(labels, dict):
        return None
    return _clean_string(labels.get("taskType"))


def ensure_task_device_id(
    task: TaskResource,
    *,
    device_id: str | None,
) -> bool:
    """Persist a resolved device id on a task that does not already have one."""

    if extract_task_type(task) == "code":
        return False

    resolved_device_id = _clean_string(device_id)
    if not resolved_device_id or extract_task_device_id(task):
        return False

    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.setdefault("spec", {})
    if not isinstance(spec, dict):
        task_json["spec"] = spec = {}
    spec["device_id"] = resolved_device_id
    task.json = task_json
    return True


def _extract_project_device_id(
    db: Session,
    *,
    user_id: int,
    project_id: int | None,
    client_origin: str | None,
) -> str | None:
    if not project_id:
        return None

    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)

    project = query.first()
    if project is None or not isinstance(project.config, dict):
        return None

    execution = project.config.get("execution")
    if isinstance(execution, dict):
        target_type = execution.get("targetType")
        if target_type in {
            DeviceType.LOCAL.value,
            DeviceType.CLOUD.value,
            DeviceType.REMOTE.value,
        }:
            return _clean_string(execution.get("deviceId"))

    return _clean_string(project.config.get("device_id"))


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None
