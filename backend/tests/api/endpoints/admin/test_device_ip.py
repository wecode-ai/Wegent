# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin lookup of a device's directly reachable Executor gateway."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User

ENDPOINT = "/api/internal/admin/devices/{device_id}/ip"
MISSING = object()


def _create_device(
    db: Session,
    *,
    user_id: int,
    device_id: str = "device-1",
    device_type: str = "local",
    client_ip: str | None = "127.0.0.1",
    runtime_transfer_host: str | None = "10.0.0.5",
    runtime_transfer_port: object = MISSING,
) -> None:
    spec = {
        "deviceId": device_id,
        "deviceType": device_type,
        "clientIp": client_ip,
        "runtimeTransferHost": runtime_transfer_host,
    }
    if runtime_transfer_port is not MISSING:
        spec["runtimeTransferPort"] = runtime_transfer_port
    db.add(
        Kind(
            user_id=user_id,
            kind="Device",
            name=device_id,
            namespace="default",
            is_active=True,
            json={"spec": spec},
        )
    )
    db.commit()


@pytest.mark.parametrize("device_type", ["local", "app", "cloud", "remote"])
def test_admin_reads_runtime_gateway_for_any_device_type(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
    device_type: str,
) -> None:
    _create_device(
        test_db,
        user_id=test_user.id,
        runtime_transfer_host="2001:0db8:0:0::5",
        device_type=device_type,
    )

    response = test_client.get(
        ENDPOINT.format(device_id="device-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "device_id": "device-1",
        "ip_address": "2001:db8::5",
        "port": 17888,
        "observed_at": None,
    }


def test_runtime_gateway_uses_reported_port(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    _create_device(
        test_db,
        user_id=test_user.id,
        runtime_transfer_host="10.185.18.119",
        runtime_transfer_port=23456,
    )

    response = test_client.get(
        ENDPOINT.format(device_id="device-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] == "10.185.18.119"
    assert response.json()["port"] == 23456


def test_runtime_gateway_falls_back_to_usable_client_ip(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    _create_device(
        test_db,
        user_id=test_user.id,
        runtime_transfer_host="127.0.0.1",
        client_ip="10.185.18.120",
        runtime_transfer_port=17889,
    )

    response = test_client.get(
        ENDPOINT.format(device_id="device-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] == "10.185.18.120"
    assert response.json()["port"] == 17889


@pytest.mark.parametrize(
    ("runtime_transfer_host", "client_ip"),
    [
        ("127.0.0.1", "::1"),
        ("0.0.0.0", "::"),
        ("224.0.0.1", "ff02::1"),
        ("169.254.1.1", "fe80::1"),
        ("not-an-ip", None),
    ],
)
def test_unusable_device_ips_hide_gateway_port(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
    runtime_transfer_host: str,
    client_ip: str | None,
) -> None:
    _create_device(
        test_db,
        user_id=test_user.id,
        runtime_transfer_host=runtime_transfer_host,
        client_ip=client_ip,
        runtime_transfer_port=17888,
    )

    response = test_client.get(
        ENDPOINT.format(device_id="device-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] is None
    assert response.json()["port"] is None


@pytest.mark.parametrize("runtime_transfer_port", [None, 0, 65536, True, "17888"])
def test_explicit_invalid_gateway_port_does_not_use_legacy_default(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
    runtime_transfer_port: object,
) -> None:
    _create_device(
        test_db,
        user_id=test_user.id,
        runtime_transfer_port=runtime_transfer_port,
    )

    response = test_client.get(
        ENDPOINT.format(device_id="device-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] == "10.0.0.5"
    assert response.json()["port"] is None


def test_lookup_requires_admin_and_accepts_admin_api_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    test_admin_api_key: tuple[str, object],
) -> None:
    _create_device(test_db, user_id=test_user.id)
    url = ENDPOINT.format(device_id="device-1")

    assert test_client.get(url).status_code == 401
    assert (
        test_client.get(
            url, headers={"Authorization": f"Bearer {test_token}"}
        ).status_code
        == 403
    )
    response = test_client.get(url, headers={"X-API-Key": test_admin_api_key[0]})
    assert response.status_code == 200
    assert response.json()["ip_address"] == "10.0.0.5"
    assert response.json()["port"] == 17888


def test_lookup_rejects_missing_and_ambiguous_devices(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    test_admin_token: str,
) -> None:
    headers = {"Authorization": f"Bearer {test_admin_token}"}
    assert (
        test_client.get(
            ENDPOINT.format(device_id="missing"), headers=headers
        ).status_code
        == 404
    )
    _create_device(test_db, user_id=test_user.id, device_id="duplicate")
    _create_device(test_db, user_id=test_admin_user.id, device_id="duplicate")

    response = test_client.get(ENDPOINT.format(device_id="duplicate"), headers=headers)

    assert response.status_code == 409


def test_exact_name_lookup_has_composite_index(test_db: Session) -> None:
    plan = test_db.execute(
        text(
            "EXPLAIN QUERY PLAN SELECT * FROM kinds "
            "WHERE name = 'device-1' AND kind = 'Device' "
            "AND namespace = 'default' AND is_active = 1 LIMIT 2"
        )
    ).fetchall()

    assert "idx_kinds_name_kind_ns_active" in " ".join(str(row) for row in plan)
