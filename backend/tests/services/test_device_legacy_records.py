"""Legacy app identity isolation and exact record removal regressions."""

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.api.endpoints import devices as devices_api
from app.models.kind import Kind
from app.services.device import record_operations
from app.services.device.identity import DeviceIdentityConflictError, record_route_id
from app.services.device.local_provider import AppDeviceProvider
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.device_service import device_service


@pytest.fixture
def records(test_db):
    rows = [
        Kind(
            user_id=7,
            namespace="default",
            name="local-device",
            kind="Device",
            json={
                "spec": {
                    "deviceType": "app",
                    "deviceId": "local-device",
                    "runtimeInstanceId": f"runtime-{index}",
                    "appDeviceId": f"electron-{index}",
                }
            },
        )
        for index in range(2)
    ]
    test_db.add_all(rows)
    test_db.commit()
    return rows


@pytest.fixture
def isolated_cache(monkeypatch):
    values = {}

    @asynccontextmanager
    async def lock(user_id):
        client = AsyncMock()
        client.mget.side_effect = lambda keys: [
            json.dumps(values[key]) if key in values else None for key in keys
        ]
        yield client

    monkeypatch.setattr(record_operations, "app_identity_lock", lock)
    monkeypatch.setattr(
        record_operations.cache_manager,
        "get",
        AsyncMock(side_effect=lambda key: values.get(key)),
    )
    monkeypatch.setattr(
        record_operations.cache_manager,
        "mget",
        AsyncMock(side_effect=lambda keys: {key: values.get(key) for key in keys}),
    )
    return values


async def test_same_logical_id_has_independent_online_records(
    test_db, records, isolated_cache
):
    for row in records:
        isolated_cache[f"device:online:7:{record_route_id(row)}"] = {
            "runtime_instance_id": row.json["spec"]["runtimeInstanceId"],
            "status": "online",
        }
    devices = await AppDeviceProvider().list_devices(test_db, 7)
    assert [device["status"] for device in devices] == ["online", "online"]
    assert len({device["execution_target_id"] for device in devices}) == 2
    assert (
        resolve_runtime_route_identity(
            test_db, user_id=7, submitted_device_id="local-device"
        )
        is None
    )
    for row in records:
        route = resolve_runtime_route_identity(
            test_db, user_id=7, submitted_device_id=record_route_id(row)
        )
        assert route.runtime_instance_id == row.json["spec"]["runtimeInstanceId"]
        assert (
            resolve_runtime_route_identity(
                test_db, user_id=8, submitted_device_id=record_route_id(row)
            )
            is None
        )


async def test_remove_only_clicked_offline_record_and_reconnect(
    test_db, records, isolated_cache
):
    kept, removed = records
    isolated_cache[f"device:online:7:{record_route_id(kept)}"] = {
        "runtime_instance_id": "runtime-0",
        "status": "online",
    }
    assert await record_operations.delete_device_record(test_db, 8, removed.id) is False
    with pytest.raises(DeviceIdentityConflictError, match="online or busy"):
        await record_operations.delete_device_record(test_db, 7, kept.id)
    assert await record_operations.delete_device_record(test_db, 7, removed.id) is True
    test_db.refresh(kept)
    test_db.refresh(removed)
    assert kept.is_active is True and removed.is_active is False
    assert len(await AppDeviceProvider().list_devices(test_db, 7)) == 1
    restored = device_service.upsert_device_crd(
        test_db,
        7,
        "local-device",
        "Wework",
        device_type="app",
        runtime_instance_id="runtime-1",
        app_device_id="electron-1",
    )
    assert restored.id == removed.id and restored.is_active is True


def test_legacy_conversation_reference_is_not_rewritten(test_db, records):
    from app.models.task import TaskResource
    from app.services.chat.storage.task_manager import TaskCreationParams
    from app.services.chat.task_device_resolution import resolve_chat_task_device_id

    records[1].is_active = False
    test_db.commit()
    task = TaskResource(json={"spec": {"device_id": "local-device"}})
    before = task.json.copy()
    route = resolve_chat_task_device_id(
        test_db, user_id=7, params=TaskCreationParams(message="follow up"), task=task
    )
    assert route == record_route_id(records[0])
    assert task.json == before


def test_ambiguous_ipc_alias_never_selects_first_installation(test_db, records):
    from fastapi import HTTPException

    from app.services.chat.task_device_resolution import (
        resolve_local_executor_device_id,
    )

    for row in records:
        row.json = {"spec": {**row.json["spec"], "appDeviceId": "legacy-ipc"}}
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        resolve_local_executor_device_id(test_db, user_id=7, device_id="legacy-ipc")
    assert error.value.status_code == 409


@pytest.mark.parametrize("use_record_route", [False, True])
async def test_offline_device_with_unfinished_task_cannot_be_removed(
    test_db, records, isolated_cache, use_record_route
):
    from app.models.subtask import Subtask

    row = records[0]
    target = record_route_id(row) if use_record_route else row.name
    subtask = Subtask(
        user_id=7,
        task_id=1,
        team_id=1,
        title="Pending",
        bot_ids=[],
        executor_name=f"device-{target}",
        status="PENDING",
    )
    test_db.add(subtask)
    test_db.commit()
    with pytest.raises(DeviceIdentityConflictError, match="online or busy"):
        await record_operations.delete_device_record(test_db, 7, row.id)
    subtask.status = "COMPLETED"
    test_db.commit()
    assert await record_operations.delete_device_record(test_db, 7, row.id)


async def test_cache_failure_does_not_remove_device(test_db, records, monkeypatch):
    from redis.exceptions import ConnectionError

    @asynccontextmanager
    async def lock(user_id):
        client = AsyncMock()
        client.mget.side_effect = ConnectionError("unavailable")
        yield client

    monkeypatch.setattr(record_operations, "app_identity_lock", lock)
    with pytest.raises(ConnectionError):
        await record_operations.delete_device_record(test_db, 7, records[0].id)
    test_db.rollback()
    assert all(row.is_active for row in records)


@pytest.mark.parametrize("device_type", ["app", "remote", "local", "cloud"])
@pytest.mark.parametrize("device_status", ["online", "busy", "offline"])
@pytest.mark.parametrize("by_record", [True, False])
async def test_both_delete_endpoints_enforce_device_type_and_status(
    test_db, isolated_cache, device_type, device_status, by_record
):
    device = Kind(
        user_id=7,
        namespace="default",
        kind="Device",
        name="delete-policy-device",
        json={"spec": {"deviceType": device_type, "runtimeInstanceId": "runtime-1"}},
    )
    test_db.add(device)
    test_db.commit()
    if device_status != "offline":
        isolated_cache[f"device:online:7:{record_route_id(device)}"] = {
            "status": device_status,
            "runtime_instance_id": "runtime-1",
        }
    endpoint = (
        devices_api.delete_device_by_record if by_record else devices_api.delete_device
    )
    target = device.id if by_record else device.name
    removable = device_type == "cloud" or device_status == "offline"

    if removable:
        await endpoint(target, db=test_db, current_user=SimpleNamespace(id=7))
    else:
        with pytest.raises(HTTPException) as error:
            await endpoint(target, db=test_db, current_user=SimpleNamespace(id=7))
        assert error.value.status_code == 409

    test_db.refresh(device)
    assert device.is_active is not removable


@pytest.mark.parametrize("device_type", ["app", "remote", "local", "cloud"])
async def test_busy_cloud_removal_preserves_unfinished_task_history(
    test_db, records, isolated_cache, device_type
):
    from app.models.subtask import Subtask

    device = records[0]
    device.json = {"spec": {**device.json["spec"], "deviceType": device_type}}
    task = Subtask(
        user_id=7,
        task_id=1,
        team_id=1,
        title="Running",
        bot_ids=[],
        executor_name=f"device-{record_route_id(device)}",
        status="RUNNING",
    )
    test_db.add(task)
    test_db.commit()

    if device_type == "cloud":
        assert await record_operations.delete_device_record(test_db, 7, device.id)
    else:
        with pytest.raises(DeviceIdentityConflictError, match="online or busy"):
            await record_operations.delete_device_record(test_db, 7, device.id)

    test_db.refresh(task)
    test_db.refresh(device)
    assert task.status == "RUNNING"
    assert device.is_active is (device_type != "cloud")
