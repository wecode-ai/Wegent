# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin lookup of the backend-observed cloud device IP."""

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User

ENDPOINT = "/api/internal/admin/cloud-devices/{device_id}/ip"


def _create_device(
    db: Session,
    *,
    user_id: int,
    device_id: str = "cloud-1",
    device_type: str = "cloud",
    client_ip: str | None = "192.0.2.42",
) -> None:
    db.add(
        Kind(
            user_id=user_id,
            kind="Device",
            name=device_id,
            namespace="default",
            is_active=True,
            json={
                "spec": {
                    "deviceId": device_id,
                    "deviceType": device_type,
                    "clientIp": client_ip,
                    "runtimeTransferHost": "10.0.0.5",
                }
            },
        )
    )
    db.commit()


def test_admin_reads_backend_observed_ip(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    _create_device(test_db, user_id=test_user.id, client_ip="2001:0db8:0:0::5")

    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "device_id": "cloud-1",
        "ip_address": "2001:db8::5",
        "observed_at": None,
    }


def test_missing_or_invalid_observed_ip_returns_null(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    _create_device(test_db, user_id=test_user.id, client_ip="not-an-ip")

    response = test_client.get(
        ENDPOINT.format(device_id="cloud-1"),
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json()["ip_address"] is None
    assert response.json()["observed_at"] is None


def test_lookup_requires_admin_and_accepts_admin_api_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    test_admin_api_key: tuple[str, object],
) -> None:
    _create_device(test_db, user_id=test_user.id)
    url = ENDPOINT.format(device_id="cloud-1")

    assert test_client.get(url).status_code == 401
    assert (
        test_client.get(
            url, headers={"Authorization": f"Bearer {test_token}"}
        ).status_code
        == 403
    )
    response = test_client.get(url, headers={"X-API-Key": test_admin_api_key[0]})
    assert response.status_code == 200
    assert response.json()["ip_address"] == "192.0.2.42"


def test_lookup_rejects_missing_noncloud_and_ambiguous_devices(
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
    _create_device(test_db, user_id=test_user.id, device_type="local")
    assert (
        test_client.get(
            ENDPOINT.format(device_id="cloud-1"), headers=headers
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
            "WHERE name = 'cloud-1' AND kind = 'Device' "
            "AND namespace = 'default' AND is_active = 1 LIMIT 2"
        )
    ).fetchall()

    assert "ix_kinds_name_kind_ns_active" in " ".join(str(row) for row in plan)
