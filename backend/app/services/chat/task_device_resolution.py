# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve the local execution device for chat task dispatch."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.kind import Kind
from app.models.project import Project
from app.models.task import TaskResource
from app.schemas.device import DeviceType
from app.services.device.local_provider import LocalDeviceProvider

if TYPE_CHECKING:
    from app.services.chat.storage.task_manager import TaskCreationParams


def resolve_chat_task_device_id(
    db: Session,
    *,
    user_id: int,
    params: "TaskCreationParams",
    task: TaskResource | None = None,
) -> str | None:
    """Resolve the device used to dispatch a chat task."""

    explicit_device_id = _clean_string(params.device_id)
    if explicit_device_id:
        return resolve_local_executor_device_id(
            db,
            user_id=user_id,
            device_id=explicit_device_id,
        )

    project_id = params.project_id or getattr(task, "project_id", 0) or 0
    client_origin = params.client_origin or getattr(task, "client_origin", None)
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

    task_device_id = extract_task_device_id(task)
    if task_device_id:
        return resolve_local_executor_device_id(
            db,
            user_id=user_id,
            device_id=task_device_id,
        )

    return None


async def resolve_chat_task_dispatch_device_id(
    db: Session,
    *,
    user_id: int,
    params: "TaskCreationParams",
    task: TaskResource | None = None,
) -> str | None:
    """Resolve the currently available local execution device for dispatch."""

    device_id = resolve_chat_task_device_id(
        db,
        user_id=user_id,
        params=params,
        task=task,
    )
    if not device_id:
        return None

    return await resolve_online_local_executor_device_id(
        db,
        user_id=user_id,
        device_id=device_id,
    )


async def resolve_online_local_executor_device_id(
    db: Session,
    *,
    user_id: int,
    device_id: str | None,
) -> str | None:
    """Resolve stale local device ids to the only online local executor."""

    candidate = resolve_local_executor_device_id(
        db,
        user_id=user_id,
        device_id=device_id,
    )
    if not candidate:
        return None

    local_devices = _list_local_devices(db, user_id=user_id)
    online_device_ids = await _online_local_device_ids(
        user_id=user_id,
        local_devices=local_devices,
    )
    if candidate in online_device_ids:
        return candidate

    local_device_ids = {
        device_id
        for device in _list_local_devices(
            db,
            user_id=user_id,
            include_inactive=True,
        )
        if (device_id := _clean_string(device.name))
    }
    if candidate in local_device_ids and len(online_device_ids) == 1:
        return next(iter(online_device_ids))

    return candidate


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
            return candidate

    for device in devices:
        device_json = device.json if isinstance(device.json, dict) else {}
        spec = device_json.get("spec")
        if not isinstance(spec, dict):
            continue
        if _clean_string(spec.get("appDeviceId")) == candidate:
            return _clean_string(device.name) or candidate

    return candidate


def _list_local_devices(
    db: Session,
    *,
    user_id: int,
    include_inactive: bool = False,
) -> list[Kind]:
    query = db.query(Kind).filter(
        Kind.user_id == user_id,
        Kind.kind == "Device",
        Kind.namespace == "default",
    )
    if not include_inactive:
        query = query.filter(Kind.is_active == True)
    devices = query.all()
    return [device for device in devices if _is_local_device(device)]


async def _online_local_device_ids(
    *,
    user_id: int,
    local_devices: list[Kind],
) -> set[str]:
    if not local_devices:
        return set()

    keys = [
        LocalDeviceProvider.generate_online_key(user_id, device.name)
        for device in local_devices
    ]
    online_info_by_key = await cache_manager.mget(keys)
    online_device_ids: set[str] = set()

    for device, key in zip(local_devices, keys):
        if online_info_by_key.get(key) is not None:
            device_id = _clean_string(device.name)
            if device_id:
                online_device_ids.add(device_id)

    return online_device_ids


def _is_local_device(device: Kind) -> bool:
    device_json = device.json if isinstance(device.json, dict) else {}
    spec = device_json.get("spec")
    if not isinstance(spec, dict):
        return False
    return spec.get("deviceType", DeviceType.LOCAL.value) == DeviceType.LOCAL.value


def extract_task_device_id(task: TaskResource | None) -> str | None:
    """Extract a task-level device id from Task spec."""

    task_json = getattr(task, "json", None)
    if not isinstance(task_json, dict):
        return None
    spec = task_json.get("spec")
    if not isinstance(spec, dict):
        return None
    return _clean_string(spec.get("device_id"))


def ensure_task_device_id(
    task: TaskResource,
    *,
    device_id: str | None,
) -> bool:
    """Persist a resolved device id on a task that does not already have one."""

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
    if isinstance(execution, dict) and execution.get("targetType") == "local":
        device_id = _clean_string(execution.get("deviceId"))
        if device_id:
            return device_id

    return _clean_string(project.config.get("device_id"))


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None
