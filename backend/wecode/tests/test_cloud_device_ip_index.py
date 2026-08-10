# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the persisted Nevis cloud-device IP index."""

import asyncio
import copy
from contextlib import nullcontext
from typing import Any, Dict, Optional

import pytest
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from wecode.service.cloud_device_ip_index import (
    NEVIS_IP_BACKFILL_LOCK_KEY,
    NEVIS_IP_FIELD,
    NEVIS_IP_OBSERVED_AT_FIELD,
    NEVIS_IP_SANDBOX_ID_FIELD,
    CloudDeviceIpIndexService,
    get_indexed_nevis_ip,
    normalize_nevis_ip,
)


class FakeNevisClient:
    def __init__(self, responses: Dict[str, Any]):
        self.responses = responses
        self.calls = []

    def is_configured(self) -> bool:
        return True

    async def get_sandbox(self, sandbox_id: str, http_client=None) -> Dict[str, Any]:
        self.calls.append((sandbox_id, http_client))
        response = self.responses[sandbox_id]
        if isinstance(response, Exception):
            raise response
        return response


class BlockingNevisClient(FakeNevisClient):
    def __init__(self, responses: Dict[str, Any]):
        super().__init__(responses)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def get_sandbox(self, sandbox_id: str, http_client=None) -> Dict[str, Any]:
        self.started.set()
        await self.release.wait()
        return await super().get_sandbox(sandbox_id, http_client=http_client)


class SandboxChangingNevisClient(FakeNevisClient):
    def __init__(self, responses: Dict[str, Any], db: Session, device: Kind):
        super().__init__(responses)
        self.db = db
        self.device = device

    async def get_sandbox(self, sandbox_id: str, http_client=None) -> Dict[str, Any]:
        device_json = copy.deepcopy(self.device.json)
        device_json["spec"]["cloudConfig"]["sandboxId"] = "sandbox-2"
        self.device.json = device_json
        flag_modified(self.device, "json")
        self.db.commit()
        return await super().get_sandbox(sandbox_id, http_client=http_client)


class FakeRedisLock:
    def __init__(self, redis, key: str):
        self.redis = redis
        self.key = key
        self.owner = object()

    async def acquire(self, blocking=False):
        if self.key in self.redis.owners:
            return False
        self.redis.owners[self.key] = self.owner
        return True

    async def extend(self, _ttl, replace_ttl=False):
        return await self.owned()

    async def owned(self):
        return self.redis.owners.get(self.key) is self.owner

    async def release(self):
        if await self.owned():
            del self.redis.owners[self.key]


class FakeRedis:
    def __init__(self):
        self.owners = {}

    def lock(self, key, **_kwargs):
        return FakeRedisLock(self, key)

    async def aclose(self):
        return None


class FailingRedis(FakeRedis):
    def lock(self, key, **_kwargs):
        raise ConnectionError("Redis unavailable")


def _create_cloud_device(
    db: Session,
    *,
    user_id: int,
    device_name: str,
    sandbox_id: str,
    bind_shell: str = "claudecode",
    nevis_ip: Optional[str] = None,
    associate_nevis_ip: bool = True,
) -> Kind:
    cloud_config = {"sandboxId": sandbox_id}
    if nevis_ip:
        cloud_config[NEVIS_IP_FIELD] = nevis_ip
        cloud_config[NEVIS_IP_OBSERVED_AT_FIELD] = "2020-01-01T00:00:00+00:00"
        if associate_nevis_ip:
            cloud_config[NEVIS_IP_SANDBOX_ID_FIELD] = sandbox_id
    device = Kind(
        user_id=user_id,
        kind="Device",
        namespace="default",
        name=device_name,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_name, "namespace": "default"},
            "spec": {
                "deviceId": device_name,
                "deviceType": "cloud",
                "bindShell": bind_shell,
                "cloudConfig": cloud_config,
            },
            "status": {"state": "Available"},
        },
    )
    db.add(device)
    db.commit()
    return device


@pytest.mark.asyncio
async def test_sync_missing_persists_authoritative_nevis_ip(test_db: Session):
    device = _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
    )
    client = FakeNevisClient({"sandbox-1": {"details": {"urls": "2001:0db8:0:0::5"}}})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_missing(test_db, FakeRedis())

    test_db.refresh(device)
    cloud_config = device.json["spec"]["cloudConfig"]
    assert summary.total == 1
    assert summary.persisted == 1
    assert summary.failed == 0
    assert cloud_config[NEVIS_IP_FIELD] == "2001:db8::5"
    assert cloud_config[NEVIS_IP_OBSERVED_AT_FIELD]
    assert cloud_config[NEVIS_IP_SANDBOX_ID_FIELD] == "sandbox-1"
    assert client.calls[0][0] == "sandbox-1"
    assert client.calls[0][1] is not None


@pytest.mark.asyncio
async def test_sync_missing_skips_existing_index_entries(test_db: Session):
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-indexed",
        sandbox_id="sandbox-1",
        nevis_ip="10.84.30.133",
    )
    client = FakeNevisClient({})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_missing(test_db, FakeRedis())

    assert summary.total == 0
    assert summary.persisted == 0
    assert client.calls == []


@pytest.mark.asyncio
async def test_sync_missing_queries_shared_sandbox_once_and_skips_openclaw(
    test_db: Session,
):
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-claudecode",
        sandbox_id="sandbox-1",
    )
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-openclaw",
        sandbox_id="sandbox-1",
        bind_shell="openclaw",
    )
    client = FakeNevisClient({"sandbox-1": {"details": {"urls": "10.84.30.133"}}})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_missing(test_db, FakeRedis())

    assert summary.total == 1
    assert summary.persisted == 1
    assert [sandbox_id for sandbox_id, _ in client.calls] == ["sandbox-1"]


@pytest.mark.asyncio
async def test_sync_missing_preserves_unassociated_ip_when_nevis_fails(
    test_db: Session,
):
    device = _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
        nevis_ip="10.84.30.132",
        associate_nevis_ip=False,
    )
    client = FakeNevisClient({"sandbox-1": RuntimeError("Nevis unavailable")})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_missing(test_db, FakeRedis())

    test_db.refresh(device)
    assert summary.persisted == 0
    assert summary.failed == 1
    assert device.json["spec"]["cloudConfig"][NEVIS_IP_FIELD] == "10.84.30.132"


@pytest.mark.asyncio
async def test_sync_missing_allows_only_one_instance(test_db: Session):
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
    )
    client = BlockingNevisClient({"sandbox-1": {"details": {"urls": "10.84.30.133"}}})
    redis_client = FakeRedis()
    service = CloudDeviceIpIndexService(client=client)

    first_sync = asyncio.create_task(service.sync_missing(test_db, redis_client))
    await client.started.wait()
    second_summary = await service.sync_missing(test_db, redis_client)
    client.release.set()
    first_summary = await first_sync

    assert first_summary.persisted == 1
    assert second_summary.skipped is True
    assert second_summary.skip_reason == "lock_not_acquired"
    assert [sandbox_id for sandbox_id, _ in client.calls] == ["sandbox-1"]
    assert NEVIS_IP_BACKFILL_LOCK_KEY not in redis_client.owners


@pytest.mark.asyncio
async def test_sync_missing_fails_closed_when_redis_is_unavailable(test_db: Session):
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
    )
    client = FakeNevisClient({"sandbox-1": {"details": {"urls": "10.84.30.133"}}})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_missing(test_db, FailingRedis())

    assert summary.skipped is True
    assert summary.skip_reason == "lock_not_acquired"
    assert client.calls == []


@pytest.mark.asyncio
async def test_sync_device_uses_per_device_lock(test_db: Session):
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
    )
    client = BlockingNevisClient({"sandbox-1": {"details": {"urls": "10.84.30.133"}}})
    redis_client = FakeRedis()
    service = CloudDeviceIpIndexService(
        client=client,
        db_session_factory=lambda: nullcontext(test_db),
        retry_delays=(0,),
    )

    first_sync = asyncio.create_task(service.sync_device(7, "device-1", redis_client))
    await client.started.wait()
    second_result = await service.sync_device(7, "device-1", redis_client)
    client.release.set()
    first_result = await first_sync

    assert first_result is True
    assert second_result is False
    assert [sandbox_id for sandbox_id, _ in client.calls] == ["sandbox-1"]
    assert redis_client.owners == {}


@pytest.mark.asyncio
async def test_sync_missing_rejects_observation_after_sandbox_changes(
    test_db: Session,
):
    device = _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
    )
    client = SandboxChangingNevisClient(
        {"sandbox-1": {"details": {"urls": "10.84.30.133"}}},
        test_db,
        device,
    )
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_missing(test_db, FakeRedis())

    test_db.refresh(device)
    cloud_config = device.json["spec"]["cloudConfig"]
    assert summary.persisted == 0
    assert cloud_config["sandboxId"] == "sandbox-2"
    assert NEVIS_IP_FIELD not in cloud_config


@pytest.mark.parametrize(
    ("cloud_config", "expected"),
    [
        (
            {
                "sandboxId": "sandbox-1",
                NEVIS_IP_SANDBOX_ID_FIELD: "sandbox-1",
                NEVIS_IP_FIELD: "2001:0db8::5",
            },
            "2001:db8::5",
        ),
        (
            {
                "sandboxId": "sandbox-2",
                NEVIS_IP_SANDBOX_ID_FIELD: "sandbox-1",
                NEVIS_IP_FIELD: "10.84.30.133",
            },
            None,
        ),
        ({"sandboxId": "sandbox-1", NEVIS_IP_FIELD: "10.84.30.133"}, None),
    ],
)
def test_get_indexed_nevis_ip(cloud_config: Dict[str, Any], expected: Optional[str]):
    assert get_indexed_nevis_ip(cloud_config) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("10.84.30.133", "10.84.30.133"),
        ("2001:0db8:0:0::5", "2001:db8::5"),
        ("not-an-ip", None),
        (None, None),
    ],
)
def test_normalize_nevis_ip(raw: Any, expected: Optional[str]):
    assert normalize_nevis_ip(raw) == expected
