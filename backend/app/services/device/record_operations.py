# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Record-scoped device removal and app registration locking."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from redis.asyncio import Redis
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.kind import Kind
from app.services.device.identity import (
    DeviceIdentityConflictError,
    lock_device_owner,
    record_route_id,
)
from app.stores.tasks import subtask_store
from shared.telemetry.decorators import trace_async


@asynccontextmanager
async def app_identity_lock(user_id: int) -> AsyncIterator[Redis]:
    """Cover the database-to-online transition so deletion cannot race it."""
    client = await cache_manager._get_client()
    try:
        async with client.lock(
            f"device:identity-lock:{user_id}", timeout=30, blocking_timeout=10
        ):
            async with asyncio.timeout(20):
                yield client
    finally:
        await client.aclose()


@trace_async("device.record.delete", tracer_name="backend.device")
async def delete_device_record(db: Session, user_id: int, record_id: int) -> bool:
    async with app_identity_lock(user_id) as client:
        lock_device_owner(db, user_id)
        device = (
            db.query(Kind)
            .filter_by(
                id=record_id,
                user_id=user_id,
                namespace="default",
                kind="Device",
                is_active=True,
            )
            .with_for_update()
            .one_or_none()
        )
        if device is None:
            db.rollback()
            return False
        if device.json.get("spec", {}).get("deviceType") != "cloud":
            await _require_offline_and_idle(db, client, user_id, device)
        device.is_active = False
        db.commit()
        return True


async def _require_offline_and_idle(
    db: Session, client: Redis, user_id: int, device: Kind
) -> None:
    """Only cloud registrations may be removed while online or busy."""
    # Older running servers may still publish under the logical ID.
    # Read strictly: a cache failure is not evidence that deletion is safe.
    raw = await client.mget(
        [
            f"device:online:{user_id}:{record_route_id(device)}",
            f"device:online:{user_id}:{device.name}",
        ]
    )
    online, legacy = [json.loads(value) if value else None for value in raw]
    runtime = device.json.get("spec", {}).get("runtimeInstanceId")
    running = subtask_store.has_active_by_executor_names(
        db,
        user_id=user_id,
        executor_names=[f"device-{record_route_id(device)}", f"device-{device.name}"],
    )
    if (
        online
        or running
        or (legacy and (not runtime or legacy.get("runtime_instance_id") == runtime))
    ):
        db.rollback()
        raise DeviceIdentityConflictError(
            "Device is online or busy; disconnect it before removal"
        )
