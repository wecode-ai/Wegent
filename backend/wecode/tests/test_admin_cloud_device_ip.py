# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal admin lookup of cloud-device Nevis IPs."""

import asyncio
import copy
from contextlib import asynccontextmanager, nullcontext
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from wecode.service import cloud_device_ip_index as index_module
from wecode.service.cloud_device_ip_index import (
    NEVIS_IP_FIELD,
    NEVIS_IP_OBSERVED_AT_FIELD,
    NEVIS_IP_SANDBOX_ID_FIELD,
    CloudDeviceIpInvalidResponse,
    CloudDeviceIpLookupBusy,
    cloud_device_ip_index_service,
)
from wecode.tests.test_cloud_device_ip_index import BlockingNevisClient, FakeRedis

ENDPOINT = "/api/internal/admin/cloud-devices/{device_id}/ip"


def _create_device(
    db: Session,
    *,
    user_id: int,
    device_id: str = "cloud-1",
    device_type: str = "cloud",
    sandbox_id: str = "sandbox-1",
    ip_address: str | None = None,
    indexed_sandbox_id: str | None = None,
    bind_shell: str = "claudecode",
) -> Kind:
    cloud_config = {"sandboxId": sandbox_id}
    if ip_address:
        cloud_config.update(
            {
                NEVIS_IP_FIELD: ip_address,
                NEVIS_IP_OBSERVED_AT_FIELD: "2026-09-20T00:00:00+00:00",
                NEVIS_IP_SANDBOX_ID_FIELD: indexed_sandbox_id or sandbox_id,
            }
        )
    device = Kind(
        user_id=user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "deviceId": device_id,
                "deviceType": device_type,
                "bindShell": bind_shell,
                "cloudConfig": cloud_config,
            }
        },
    )
    db.add(device)
    db.commit()
    return device


def _admin_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_index_hit_uses_one_database_lookup_without_nevis(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    _create_device(
        test_db,
        user_id=test_user.id,
        ip_address="2001:0db8:0:0::5",
    )
    lookup = AsyncMock(side_effect=AssertionError("Nevis must not be called"))
    monkeypatch.setattr(cloud_device_ip_index_service, "lookup_missing_ip", lookup)

    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"), headers=_admin_headers(test_admin_token)
    )

    assert response.status_code == 200
    assert response.json() == {
        "device_id": "cloud-1",
        "ip_address": "2001:db8::5",
        "observed_at": "2026-09-20T00:00:00+00:00",
    }
    lookup.assert_not_awaited()


def test_index_miss_queries_nevis_once_and_persists(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    device = _create_device(
        test_db,
        user_id=test_user.id,
        bind_shell="openclaw",
        ip_address="10.9.9.9",
        indexed_sandbox_id="old-sandbox",
    )
    fake_client = AsyncMock()
    fake_client.get_sandbox.return_value = {"details": {"urls": "2001:0db8:0:0::5"}}

    @asynccontextmanager
    async def acquired_lock(*_args):
        yield True

    class FakeRedis:
        aclose = AsyncMock()

    monkeypatch.setattr(cloud_device_ip_index_service, "_client", fake_client)
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "_db_session_factory",
        lambda: nullcontext(test_db),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service, "_create_redis_client", FakeRedis
    )
    monkeypatch.setattr(index_module, "acquire_nevis_ip_lock", acquired_lock)

    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"), headers=_admin_headers(test_admin_token)
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] == "2001:db8::5"
    assert response.json()["observed_at"]
    fake_client.get_sandbox.assert_awaited_once_with("sandbox-1")
    test_db.refresh(device)
    assert device.json["spec"]["cloudConfig"][NEVIS_IP_FIELD] == "2001:db8::5"


def test_nevis_without_ip_returns_null(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    _create_device(test_db, user_id=test_user.id)
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "lookup_missing_ip",
        AsyncMock(return_value=index_module.CloudDeviceIpObservation(None, None)),
    )

    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"), headers=_admin_headers(test_admin_token)
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] is None
    assert response.json()["observed_at"] is None


@pytest.mark.parametrize(
    ("error", "expected_status"),
    [(CloudDeviceIpLookupBusy(), 503), (asyncio.TimeoutError(), 504)],
)
def test_lookup_errors_are_retryable(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
    error: Exception,
    expected_status: int,
) -> None:
    _create_device(test_db, user_id=test_user.id)
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "lookup_missing_ip",
        AsyncMock(side_effect=error),
    )

    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"), headers=_admin_headers(test_admin_token)
    )

    assert response.status_code == expected_status
    if expected_status == 503:
        assert response.headers["Retry-After"] == "1"


def test_lookup_rejects_missing_noncloud_and_ambiguous_devices(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    test_admin_token: str,
) -> None:
    headers = _admin_headers(test_admin_token)
    assert (
        test_client.get(
            ENDPOINT.format(device_id="missing"), headers=headers
        ).status_code
        == 404
    )
    _create_device(test_db, user_id=test_user.id, device_type="local")
    assert (
        test_client.get(
            ENDPOINT.format(device_id="cloud-1"), headers=headers
        ).status_code
        == 404
    )
    _create_device(test_db, user_id=test_user.id, device_id="same")
    _create_device(test_db, user_id=test_admin_user.id, device_id="same")
    assert (
        test_client.get(ENDPOINT.format(device_id="same"), headers=headers).status_code
        == 409
    )


def test_lookup_requires_admin_and_accepts_admin_api_key(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    test_admin_api_key: tuple[str, object],
) -> None:
    _create_device(test_db, user_id=test_user.id, ip_address="10.0.0.8")
    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"), headers=_admin_headers(test_token)
    )
    assert response.status_code == 403

    raw_key, _ = test_admin_api_key
    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"), headers={"X-API-Key": raw_key}
    )
    assert response.status_code == 200
    assert response.json()["ip_address"] == "10.0.0.8"


def test_sandbox_change_during_nevis_lookup_cannot_persist_old_ip(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
) -> None:
    device = _create_device(test_db, user_id=test_user.id)

    async def change_sandbox(_sandbox_id: str):
        device_json = copy.deepcopy(device.json)
        device_json["spec"]["cloudConfig"]["sandboxId"] = "sandbox-2"
        device.json = device_json
        flag_modified(device, "json")
        test_db.commit()
        return {"details": {"urls": "10.0.0.8"}}

    @asynccontextmanager
    async def acquired_lock(*_args):
        yield True

    class FakeRedis:
        aclose = AsyncMock()

    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "_client",
        type("FakeClient", (), {"get_sandbox": staticmethod(change_sandbox)})(),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "_db_session_factory",
        lambda: nullcontext(test_db),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service, "_create_redis_client", FakeRedis
    )
    monkeypatch.setattr(index_module, "acquire_nevis_ip_lock", acquired_lock)

    with pytest.raises(index_module.CloudDeviceIpLookupConflict):
        asyncio.run(
            cloud_device_ip_index_service.lookup_missing_ip(
                index_module.CloudDeviceIpTarget(test_user.id, "cloud-1", "sandbox-1")
            )
        )
    test_db.refresh(device)
    assert NEVIS_IP_FIELD not in device.json["spec"]["cloudConfig"]


@pytest.mark.asyncio
async def test_concurrent_misses_send_only_one_nevis_request(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
) -> None:
    _create_device(test_db, user_id=test_user.id)
    client = BlockingNevisClient({"sandbox-1": {"details": {"urls": "10.0.0.8"}}})
    redis_client = FakeRedis()
    monkeypatch.setattr(cloud_device_ip_index_service, "_client", client)
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "_db_session_factory",
        lambda: nullcontext(test_db),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "_create_redis_client",
        lambda: redis_client,
    )
    target = index_module.CloudDeviceIpTarget(test_user.id, "cloud-1", "sandbox-1")

    first = asyncio.create_task(cloud_device_ip_index_service.lookup_missing_ip(target))
    await client.started.wait()
    with pytest.raises(CloudDeviceIpLookupBusy):
        await cloud_device_ip_index_service.lookup_missing_ip(target)
    client.release.set()
    observation = await first

    assert observation.ip_address == "10.0.0.8"
    assert len(client.calls) == 1
    assert redis_client.owners == {}


@pytest.mark.asyncio
async def test_invalid_nevis_ip_is_rejected_without_persisting(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
) -> None:
    device = _create_device(test_db, user_id=test_user.id)

    @asynccontextmanager
    async def acquired_lock(*_args):
        yield True

    class FakeClient:
        get_sandbox = AsyncMock(return_value={"details": {"urls": "not-an-ip"}})

    class FakeRedis:
        aclose = AsyncMock()

    monkeypatch.setattr(cloud_device_ip_index_service, "_client", FakeClient())
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "_db_session_factory",
        lambda: nullcontext(test_db),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service, "_create_redis_client", FakeRedis
    )
    monkeypatch.setattr(index_module, "acquire_nevis_ip_lock", acquired_lock)

    with pytest.raises(CloudDeviceIpInvalidResponse):
        await cloud_device_ip_index_service.lookup_missing_ip(
            index_module.CloudDeviceIpTarget(test_user.id, "cloud-1", "sandbox-1")
        )
    test_db.refresh(device)
    assert NEVIS_IP_FIELD not in device.json["spec"]["cloudConfig"]


def test_exact_name_query_uses_composite_index(test_db: Session) -> None:
    plan = test_db.execute(
        text(
            "EXPLAIN QUERY PLAN SELECT id FROM kinds WHERE name=:device_id "
            "AND kind='Device' AND namespace='default' AND is_active=1"
        ),
        {"device_id": "cloud-1"},
    ).all()
    assert "ix_kinds_name_kind_ns_active" in " ".join(str(row) for row in plan)
