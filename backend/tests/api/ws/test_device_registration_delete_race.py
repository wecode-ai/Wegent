# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Registration must retain its identity lock until online state is published."""

import asyncio
import json
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace
from app.models.kind import Kind
from app.services.device import record_operations
from app.services.device.identity import DeviceIdentityConflictError
from app.services.device_service import device_service


@pytest.fixture
def cloud_registration(test_db, test_user, monkeypatch):
    record = Kind(
        user_id=test_user.id,
        kind="Device",
        namespace="default",
        name="cloud-registration-race",
        json={
            "spec": {
                "deviceType": "cloud",
                "deviceId": "cloud-executor-route",
                "runtimeInstanceId": "cloud-runtime",
                "cloudConfig": {"deviceId": "cloud-executor-route"},
            }
        },
    )
    test_db.add(record)
    test_db.commit()
    identity_lock = asyncio.Lock()
    matched, publish, delete_requested = (asyncio.Event() for _ in range(3))
    cache = {}
    attempts = 0

    @asynccontextmanager
    async def lock(user_id):
        nonlocal attempts
        assert user_id == test_user.id
        attempts += 1
        if attempts == 2:
            delete_requested.set()
        async with identity_lock:
            client = AsyncMock()
            client.mget.side_effect = lambda keys: [cache.get(key) for key in keys]
            yield client

    @contextmanager
    def session():
        yield test_db

    async def inline(function, *args):
        return function(*args)

    async def save_session(*_args):
        matched.set()
        await publish.wait()

    async def set_online(**values):
        key = f"device:online:{test_user.id}:{values['device_id']}"
        cache[key] = json.dumps({"runtime_instance_id": "cloud-runtime"})

    namespace = device_namespace.DeviceNamespace()
    monkeypatch.setattr(device_namespace, "device_identity_lock", lock)
    monkeypatch.setattr(record_operations, "device_identity_lock", lock)
    monkeypatch.setattr(device_namespace, "get_db_session", session)
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", inline)
    monkeypatch.setattr(
        namespace, "get_session", AsyncMock(return_value={"user_id": test_user.id})
    )
    monkeypatch.setattr(namespace, "save_session", save_session)
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())
    monkeypatch.setattr(namespace, "_broadcast_device_online", AsyncMock())
    monkeypatch.setattr(
        namespace,
        "_schedule_background_task",
        lambda coroutine, _name: coroutine.close(),
    )
    monkeypatch.setattr(device_service, "set_device_online", set_online)
    return record, namespace, identity_lock, matched, publish, delete_requested


@pytest.mark.asyncio
async def test_cloud_registration_and_offline_removal_are_serialized(
    cloud_registration, test_db, test_user
):
    record, namespace, lock, matched, publish, delete_requested = cloud_registration
    registering = asyncio.create_task(
        namespace.on_device_register(
            "cloud-race",
            {
                "device_id": "cloud-executor-route",
                "name": "Cloud race",
                "device_type": "cloud",
                "runtime_instance_id": "cloud-runtime",
            },
        )
    )
    deleting = None
    try:
        await asyncio.wait_for(matched.wait(), timeout=5)
        assert (
            lock.locked()
        ), "Cloud matching committed without retaining the identity lock"
        deleting = asyncio.create_task(
            record_operations.delete_device_record(
                test_db, test_user.id, record.id, offline_only=True
            )
        )
        await asyncio.wait_for(delete_requested.wait(), timeout=5)
        assert not deleting.done(), "Removal bypassed the pending registration"
        publish.set()
        assert (await registering)["success"] is True
        with pytest.raises(DeviceIdentityConflictError, match="online or busy"):
            await deleting
        test_db.refresh(record)
        assert record.is_active is True
    finally:
        publish.set()
        await asyncio.gather(
            registering, *([deleting] if deleting else []), return_exceptions=True
        )
