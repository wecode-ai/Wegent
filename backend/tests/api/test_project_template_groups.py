# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Template group contracts with existing humans and real permission checks."""

import json
import logging
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.endpoints import project_automations
from app.models.user import User

TemplateProject = tuple[str, dict[str, str], dict[str, Any]]


def _human_template_payload(humans: list[User]) -> dict[str, Any]:
    path = (
        Path(__file__).resolve().parents[3] / "shared/data/collaboration-templates.json"
    )
    template = next(
        item
        for item in json.loads(path.read_text(encoding="utf-8"))
        if item["metadata"]["name"] == "product-lifecycle"
    )
    group = template["spec"]["resources"]["collaboration"]["groups"][0]
    roles = {
        role["key"]: {
            "kind": "human",
            "id": str(human.id),
            "name": human.user_name,
            "responsibility": role["responsibility"],
        }
        for role, human in zip(group["roles"], humans, strict=True)
    }
    return {
        "name": group["name"],
        "description": group["description"],
        "instructions": group["instructions"],
        "leader": roles[group["leaderRole"]],
        "members": list(roles.values()),
        "stages": [
            {
                "id": stage["key"],
                "name": stage["name"],
                "assignee": roles[stage["ownerRole"]],
            }
            for stage in group["stages"]
        ],
    }


@pytest.fixture
def human_template_project(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> TemplateProject:
    headers = {"Authorization": f"Bearer {test_token}"}
    workspace = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "Template contracts"}
    )
    assert workspace.status_code == 201
    project = test_client.post(
        f"/api/v1/workspaces/{workspace.json()['id']}/projects",
        headers=headers,
        json={"name": "Existing human template"},
    )
    assert project.status_code == 201
    project_url = f"/api/v1/cloud-projects/{project.json()['id']}"
    humans = [test_user]
    for _ in range(5):
        name = f"template-human-{uuid.uuid4().hex[:10]}"
        human = User(
            user_name=name,
            email=f"{name}@example.com",
            password_hash="unused",
            is_active=True,
        )
        test_db.add(human)
        test_db.commit()
        test_db.refresh(human)
        added = test_client.post(
            f"{project_url}/members",
            headers=headers,
            json={"user_id": human.id, "role": "Developer"},
        )
        assert added.status_code == 201
        humans.append(human)
    return project_url, headers, _human_template_payload(humans)


def test_six_existing_humans_create_once_and_duplicate_returns_conflict(
    test_client: TestClient,
    human_template_project: TemplateProject,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project_url, headers, payload = human_template_project
    caplog.set_level(logging.INFO, logger=project_automations.__name__)

    created = test_client.post(
        f"{project_url}/collaboration-groups", headers=headers, json=payload
    )
    duplicate = test_client.post(
        f"{project_url}/collaboration-groups", headers=headers, json=payload
    )

    assert created.status_code == 201
    assert created.json()["members"] == payload["members"]
    assert len(created.json()["stages"]) == 6
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == (
        "Collaboration group name already exists in this owner scope"
    )
    groups = test_client.get(
        f"{project_url}/collaboration-groups", headers=headers
    ).json()["items"]
    assert [group["id"] for group in groups] == [created.json()["id"]]
    assert "stage=create status=409 error_type=HTTPException" in caplog.text
    assert payload["name"] not in caplog.text


def test_human_with_revoked_developer_access_returns_configuration_error(
    test_client: TestClient,
    human_template_project: TemplateProject,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project_url, headers, payload = human_template_project
    human_id = payload["members"][-1]["id"]
    changed = test_client.patch(
        f"{project_url}/members/{human_id}",
        headers=headers,
        json={"role": "Viewer"},
    )
    assert changed.status_code == 200

    response = test_client.post(
        f"{project_url}/collaboration-groups", headers=headers, json=payload
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Human is not available in this Project"
    groups = test_client.get(
        f"{project_url}/collaboration-groups", headers=headers
    ).json()["items"]
    assert groups == []
    assert "stage=create status=422 error_type=HTTPException" in caplog.text


def test_response_failure_reports_created_group_without_logging_payload(
    test_client: TestClient,
    human_template_project: TemplateProject,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project_url, headers, payload = human_template_project
    create = project_automations.workspace_service.create_project_collaboration_group

    def create_with_invalid_response(*args: Any, **kwargs: Any) -> dict[str, object]:
        result = create(*args, **kwargs)
        # Inject failure after the real transaction commits.
        return {**result, "coordination_mode": "invalid"}

    monkeypatch.setattr(
        project_automations.workspace_service,
        "create_project_collaboration_group",
        create_with_invalid_response,
    )
    client = TestClient(test_client.app, raise_server_exceptions=False)
    try:
        response = client.post(
            f"{project_url}/collaboration-groups", headers=headers, json=payload
        )
    finally:
        client.close()

    assert response.status_code == 500
    groups = test_client.get(
        f"{project_url}/collaboration-groups", headers=headers
    ).json()["items"]
    assert len(groups) == 1
    records = [
        record.getMessage()
        for record in caplog.records
        if record.name == project_automations.__name__
    ]
    assert any(
        f"group_id={groups[0]['id']} stage=response status=500 "
        "error_type=ValidationError" in message
        for message in records
    )
    assert all(payload["name"] not in message for message in records)
    assert all(payload["instructions"] not in message for message in records)
