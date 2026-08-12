# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from wecode.service.cloud_device_ip_index import (
    NEVIS_IP_FIELD,
    NEVIS_IP_OBSERVED_AT_FIELD,
    NEVIS_IP_SANDBOX_ID_FIELD,
)
from wecode.service.ip_user_lookup import ip_user_lookup_service


def _create_device(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    device_type: str,
    client_ip: str,
    nevis_ip: Optional[str] = None,
    runtime_transfer_host: Optional[str] = None,
    observed_at: Optional[str] = None,
    indexed_sandbox_id: Optional[str] = None,
) -> None:
    spec = {
        "deviceId": device_id,
        "deviceType": device_type,
        "clientIp": client_ip,
    }
    if runtime_transfer_host is not None:
        spec["runtimeTransferHost"] = runtime_transfer_host
    if device_type == "cloud" and nevis_ip is not None:
        sandbox_id = f"sandbox-{device_id}"
        spec["cloudConfig"] = {
            "sandboxId": sandbox_id,
            NEVIS_IP_FIELD: nevis_ip,
            NEVIS_IP_OBSERVED_AT_FIELD: observed_at or "2020-01-01T00:00:00+00:00",
            NEVIS_IP_SANDBOX_ID_FIELD: indexed_sandbox_id or sandbox_id,
        }
    db.add(
        Kind(
            user_id=user_id,
            kind="Device",
            name=device_id,
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Device",
                "metadata": {"name": device_id, "namespace": "default"},
                "spec": spec,
                "status": {"state": "Available"},
            },
            is_active=True,
        )
    )
    db.commit()


def test_internal_admin_ip_lookup_combines_cloud_and_pod_matches(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="cloud-1",
        device_type="cloud",
        client_ip="10.20.30.40",
        nevis_ip="10.20.30.40",
    )
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="local-1",
        device_type="local",
        client_ip="10.20.30.40",
    )
    pod_lookup = AsyncMock(
        return_value=(
            [
                {
                    "pod_name": "wegent-task-testuser-abc",
                    "namespace": "wb-plat-ide",
                    "pod_ip": "10.20.30.40",
                    "phase": "Running",
                    "user_name": test_user.user_name,
                    "task_id": "1234",
                }
            ],
            None,
        )
    )

    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "10.20.30.40"},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_names"] == [test_user.user_name]
    assert [match["source"] for match in payload["matches"]] == [
        "cloud_device",
        "k8s_pod",
    ]
    assert payload["matches"][0]["resource_name"] == "cloud-1"
    assert payload["matches"][1]["task_id"] == "1234"
    assert payload["lookup_errors"] == []
    pod_lookup.assert_awaited_once_with("10.20.30.40")


def test_internal_admin_ip_lookup_returns_partial_cloud_result(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="cloud-2",
        device_type="cloud",
        client_ip="2001:db8::5",
        nevis_ip="2001:db8::5",
    )
    pod_lookup = AsyncMock(return_value=([], "executor-manager unavailable"))

    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "2001:0db8:0:0:0:0:0:5"},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ip"] == "2001:db8::5"
    assert payload["user_names"] == [test_user.user_name]
    assert payload["lookup_errors"] == [
        {"source": "k8s_pod", "message": "executor-manager unavailable"}
    ]


def test_internal_admin_ip_lookup_resolves_indexed_nevis_cloud_ip(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="cloud-nevis",
        device_type="cloud",
        client_ip="",
        nevis_ip="10.30.40.50",
    )

    pod_lookup = AsyncMock(return_value=([], None))
    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "10.30.40.50"},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_names"] == [test_user.user_name]
    assert payload["matches"][0]["source"] == "cloud_device"
    assert payload["matches"][0]["resource_name"] == "cloud-nevis"


def test_internal_admin_ip_lookup_does_not_trust_runtime_transfer_host(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="cloud-runtime-host",
        device_type="cloud",
        client_ip="",
        nevis_ip="10.201.4.120",
        runtime_transfer_host="10.201.4.119",
    )
    pod_lookup = AsyncMock(return_value=([], None))
    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "10.201.4.119"},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_names"] == []
    assert payload["matches"] == []
    assert payload["lookup_errors"] == []


def test_internal_admin_ip_lookup_does_not_expire_nevis_index(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="cloud-stale",
        device_type="cloud",
        client_ip="",
        nevis_ip="10.201.4.121",
        observed_at="2020-01-01T00:00:00+00:00",
    )
    pod_lookup = AsyncMock(return_value=([], None))

    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "10.201.4.121"},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_names"] == [test_user.user_name]
    assert payload["lookup_errors"] == []


def test_internal_admin_ip_lookup_rejects_mismatched_sandbox_index(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    _create_device(
        test_db,
        user_id=test_user.id,
        device_id="cloud-recreated",
        device_type="cloud",
        client_ip="",
        nevis_ip="10.201.4.122",
        indexed_sandbox_id="previous-sandbox",
    )
    pod_lookup = AsyncMock(return_value=([], None))

    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "10.201.4.122"},
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_names"] == []
    assert payload["matches"] == []
    assert payload["lookup_errors"] == [
        {
            "source": "cloud_device",
            "message": "Nevis IP index is missing for 1 active cloud devices",
        }
    ]


def test_internal_admin_ip_lookup_rejects_invalid_ip(
    test_client: TestClient,
    test_admin_token: str,
):
    response = test_client.get(
        "/api/internal/admin/users/by-ip",
        params={"ip": "not-an-ip"},
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 422


def test_internal_admin_ip_lookup_requires_admin(
    test_client: TestClient,
    test_token: str,
):
    response = test_client.get(
        "/api/internal/admin/users/by-ip",
        params={"ip": "10.20.30.40"},
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 403


@pytest.mark.parametrize("header_name", ["X-API-Key", "Authorization"])
def test_internal_admin_ip_lookup_accepts_admin_api_key(
    test_client: TestClient,
    test_admin_api_key,
    header_name: str,
):
    raw_key, _ = test_admin_api_key
    header_value = raw_key if header_name == "X-API-Key" else f"Bearer {raw_key}"
    pod_lookup = AsyncMock(return_value=([], None))

    with patch.object(ip_user_lookup_service, "_find_pod_owners", pod_lookup):
        response = test_client.get(
            "/api/internal/admin/users/by-ip",
            params={"ip": "192.0.2.10"},
            headers={header_name: header_value},
        )

    assert response.status_code == 200
    assert response.json()["ip"] == "192.0.2.10"


def test_internal_admin_ip_lookup_rejects_non_admin_api_key(
    test_client: TestClient,
    test_api_key,
):
    raw_key, _ = test_api_key

    response = test_client.get(
        "/api/internal/admin/users/by-ip",
        params={"ip": "192.0.2.10"},
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_pod_lookup_calls_executor_manager(mocker):
    response = mocker.MagicMock()
    response.json.return_value = {
        "status": "success",
        "pods": [{"pod_name": "pod-1", "user_name": "alice"}],
    }
    response.raise_for_status.return_value = None
    http_client = AsyncMock()
    http_client.get.return_value = response
    context = AsyncMock()
    context.__aenter__.return_value = http_client
    mocker.patch(
        "wecode.service.ip_user_lookup.httpx.AsyncClient", return_value=context
    )

    pods, error = await ip_user_lookup_service._find_pod_owners("10.0.0.8")

    assert error is None
    assert pods == [{"pod_name": "pod-1", "user_name": "alice"}]
    http_client.get.assert_awaited_once_with(
        f"{settings.EXECUTOR_MANAGER_URL.rstrip('/')}"
        "/executor-manager/executor/pod-owners",
        params={"ip_address": "10.0.0.8"},
    )
