# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project write receipts survive removal of the actor's own direct grant."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.resource_member import ResourceMember
from app.models.user import User


def test_self_removal_returns_write_receipt_without_authorizing_future_reads(
    test_client: TestClient, test_db: Session, test_token: str
) -> None:
    owner_headers = {"Authorization": f"Bearer {test_token}"}
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=owner_headers,
        json={"name": "Departing maintainer", "project_key": "DEPART"},
    )
    assert created.status_code == 201
    project = created.json()
    actor = User(
        user_name="departing-maintainer", password_hash="unused", is_active=True
    )
    test_db.add(actor)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project["id"]),
            entity_id=str(actor.id),
            role="Maintainer",
            status="approved",
        )
    )
    test_db.commit()
    token = create_access_token(data={"sub": actor.user_name})
    headers = {"Authorization": f"Bearer {token}"}
    path = f"/api/v1/cloud-projects/{project['id']}"

    response = test_client.patch(
        path,
        headers=headers,
        json={
            "version": project["version"],
            "operation_id": "self-removal",
            "member_changes": [{"operation": "remove_direct", "user_id": actor.id}],
        },
    )

    assert response.status_code == 200
    assert response.json()["access_role"] is None
    assert response.json()["permission_sources"] == []
    assert response.json()["project_admin_capabilities"]["operations"] == []
    receipt = response.json()["project_admin_result"]
    assert receipt["auditId"]
    assert receipt["actor"]["userId"] == actor.id
    assert not any(
        member["user_id"] == actor.id for member in receipt["after"]["members"]
    )
    assert (
        test_client.get(
            f"/api/v1/projects/{project['id']}", headers=headers
        ).status_code
        == 404
    )
