# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve the only live capacity truth for one Runtime installation."""

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.services.device.local_provider import LocalDeviceProvider
from app.services.device.runtime_route import resolve_runtime_route_identity


@dataclass(frozen=True)
class RuntimeCapacity:
    runtime_instance_id: str
    limit: int
    active: int
    active_task_ids: frozenset[str]
    queued: int


def _runtime_route(
    db: Session, owner_user_id: int, device_id: str
) -> tuple[str, str] | None:
    identity = resolve_runtime_route_identity(
        db,
        user_id=owner_user_id,
        submitted_device_id=device_id,
    )
    if identity is None or not identity.runtime_instance_id:
        return None
    return identity.runtime_device_id, identity.runtime_instance_id


def _parse_capacity(
    online_info: Any, expected_instance_id: str
) -> RuntimeCapacity | None:
    if not isinstance(online_info, dict):
        return None
    reported_instance_id = str(online_info.get("runtime_instance_id") or "").strip()
    capacity = online_info.get("runtime_capacity")
    if reported_instance_id != expected_instance_id or not isinstance(capacity, dict):
        return None
    limit = capacity.get("limit")
    active = capacity.get("active")
    active_task_ids = capacity.get("active_task_ids")
    queued = capacity.get("queued")
    if (
        not isinstance(limit, int)
        or isinstance(limit, bool)
        or not 1 <= limit <= 20
        or not isinstance(active, int)
        or isinstance(active, bool)
        or active < 0
        or not isinstance(active_task_ids, list)
        or any(
            not isinstance(task_id, str) or not task_id.strip()
            for task_id in active_task_ids
        )
        or len(set(active_task_ids)) != len(active_task_ids)
        or len(active_task_ids) != active
        or not isinstance(queued, int)
        or isinstance(queued, bool)
        or queued < 0
    ):
        return None
    return RuntimeCapacity(
        runtime_instance_id=reported_instance_id,
        limit=limit,
        active=active,
        active_task_ids=frozenset(active_task_ids),
        queued=queued,
    )


def get_runtime_capacity_sync(
    db: Session, *, owner_user_id: int, device_id: str
) -> RuntimeCapacity | None:
    route = _runtime_route(db, owner_user_id, device_id)
    if route is None:
        return None
    runtime_device_id, expected_instance_id = route
    online_info = cache_manager.get_sync(
        LocalDeviceProvider.generate_online_key(owner_user_id, runtime_device_id)
    )
    return _parse_capacity(online_info, expected_instance_id)


async def get_runtime_capacity(
    db: Session, *, owner_user_id: int, device_id: str
) -> RuntimeCapacity | None:
    route = _runtime_route(db, owner_user_id, device_id)
    if route is None:
        return None
    runtime_device_id, expected_instance_id = route
    online_info = await cache_manager.get(
        LocalDeviceProvider.generate_online_key(owner_user_id, runtime_device_id)
    )
    return _parse_capacity(online_info, expected_instance_id)
