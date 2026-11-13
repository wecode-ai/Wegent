"""Unspecified project ownership uses an independent, reusable default space."""

from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.cloud_projects import cloud_project_service


@pytest.mark.parametrize("default_source", ["legacy", "create", "update"])
def test_default_space_does_not_adopt_an_existing_business_space(
    test_client: TestClient, test_db: Session, test_token: str, default_source: str
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    response = test_client.post(
        "/api/v1/workspaces",
        headers=headers,
        json={"name": "test", "is_default": default_source == "create"},
    )
    assert response.status_code == 201, response.text
    business = response.json()
    assert business["is_system_default"] is False
    if default_source == "legacy":
        business_kind = test_db.get(Kind, int(business["id"]))
        legacy = deepcopy(business_kind.json)
        legacy["spec"]["isDefault"] = True
        business_kind.json = legacy
        test_db.commit()
    elif default_source == "update":
        response = test_client.patch(
            f"/api/v1/workspaces/{business['id']}",
            headers=headers,
            json={"is_default": True, "version": business["version"]},
        )
        assert response.status_code == 200, response.text
        assert response.json()["is_system_default"] is False

    projects = []
    for name in ("First default project", "Second default project"):
        response = test_client.post(
            "/api/v1/cloud-projects", headers=headers, json={"name": name}
        )
        assert response.status_code == 201, response.text
        projects.append(response.json())

    default_id = projects[0]["workspace_id"]
    assert default_id != business["id"]
    assert projects[1]["workspace_id"] == default_id
    assert test_db.get(Kind, int(business["id"])).name == "test"
    default = test_db.get(Kind, int(default_id))
    assert default.name == "默认空间"
    assert default.json["spec"]["isSystemDefault"] is True
    for project in projects:
        parents = (
            test_db.query(ResourceMember)
            .filter_by(
                resource_type="CloudProject",
                resource_id=int(project["id"]),
                entity_type="workspace",
                status="approved",
            )
            .all()
        )
        assert [parent.entity_id for parent in parents] == [str(default_id)]

    response = test_client.post(
        f"/api/v1/workspaces/{business['id']}/projects",
        headers=headers,
        json={"name": "Explicit business project"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["workspace_id"] == business["id"]

    response = test_client.patch(
        f"/api/v1/workspaces/{default_id}",
        headers=headers,
        json={"name": "Renamed default", "version": 1},
    )
    assert response.status_code == 200, response.text
    response = test_client.post(
        "/api/v1/cloud-projects", headers=headers, json={"name": "After rename"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["workspace_id"] == default_id

    # A user preference must not replace or erase the system-default identity.
    response = test_client.get(f"/api/v1/workspaces/{business['id']}", headers=headers)
    assert response.status_code == 200, response.text
    response = test_client.patch(
        f"/api/v1/workspaces/{business['id']}",
        headers=headers,
        json={"is_default": True, "version": response.json()["version"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["is_system_default"] is False
    response = test_client.post(
        "/api/v1/cloud-projects", headers=headers, json={"name": "After preference"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["workspace_id"] == default_id


def test_transferred_default_is_not_adopted_by_either_owners_future_projects(
    test_client: TestClient, test_db: Session, test_token: str
) -> None:
    owner = {"Authorization": f"Bearer {test_token}"}
    target = User(
        user_name=f"default-transfer-{uuid4().hex[:8]}",
        password_hash="unused",
        is_active=True,
    )
    test_db.add(target)
    test_db.commit()
    recipient = {
        "Authorization": f"Bearer {create_access_token(data={'sub': target.user_name})}"
    }
    response = test_client.post(
        "/api/v1/cloud-projects", headers=owner, json={"name": "Before transfer"}
    )
    assert response.status_code == 201, response.text
    original_id = response.json()["workspace_id"]
    response = test_client.get(f"/api/v1/workspaces/{original_id}", headers=owner)
    assert response.status_code == 200, response.text
    original_owner_id = response.json()["owner_user_id"]
    response = test_client.post(
        f"/api/v1/workspaces/{original_id}/transfer-ownership",
        headers=owner,
        json={"user_id": target.id, "version": response.json()["version"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["is_system_default"] is False
    default_ids = []
    for headers, other, other_id in [
        (owner, recipient, target.id),
        (recipient, owner, original_owner_id),
    ]:
        response = test_client.post(
            "/api/v1/cloud-projects", headers=headers, json={"name": "After transfer"}
        )
        assert response.status_code == 201, response.text
        project = response.json()
        assert project["workspace_id"] != original_id
        default_ids.append(project["workspace_id"])
        denied = test_client.get(
            f"/api/v1/workspaces/{project['workspace_id']}", headers=other
        )
        assert denied.status_code == 404, denied.text
        with pytest.raises(HTTPException) as denied_project:
            cloud_project_service.get(test_db, int(project["id"]), other_id)
        assert denied_project.value.status_code == 404
    assert len(set(default_ids)) == 2
