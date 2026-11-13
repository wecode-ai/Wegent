"""Unspecified project ownership uses an independent, reusable default space."""

from copy import deepcopy

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember


def test_default_space_does_not_adopt_an_existing_business_space(
    test_client: TestClient, test_db: Session, test_token: str
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    response = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "test"}
    )
    assert response.status_code == 201, response.text
    business = response.json()
    business_kind = test_db.get(Kind, int(business["id"]))
    legacy = deepcopy(business_kind.json)
    legacy["spec"]["isDefault"] = True
    business_kind.json = legacy
    test_db.commit()

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
