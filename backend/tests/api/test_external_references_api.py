# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""REST API coverage for external reference registration."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import ExternalEventBinding, LoopItem
from app.models.user import User


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(test_client: TestClient, token: str) -> dict[str, object]:
    response = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(token),
        json={"project_key": "REG", "name": "Registration project"},
    )
    assert response.status_code == 201
    return response.json()


def _workflow_definition() -> dict:
    return {
        "version": 1,
        "stage_mode": "dag",
        "advancement_policy": "manual",
        "nodes": [
            {
                "id": "start-1",
                "name": "Start",
                "node_type": "start",
                "depends_on": [],
                "required": False,
                "workspace_policy": "none",
                "status": "completed",
            },
            {
                "id": "stage-1",
                "name": "Develop MR",
                "node_type": "stage",
                "depends_on": ["start-1"],
                "required": True,
                "workspace_policy": "composer",
                "status": "completed",
            },
            {
                "id": "wait-1",
                "name": "Wait external",
                "node_type": "wait",
                "depends_on": ["stage-1"],
                "required": True,
                "workspace_policy": "none",
                "status": "waiting",
                "wait_config": {
                    "rules": [
                        {
                            "id": "rule-merged",
                            "event_type": "merged",
                            "mode": "trigger",
                            "action": "complete",
                            "rerun_prompt": "",
                        }
                    ]
                },
            },
            {
                "id": "end-1",
                "name": "End",
                "node_type": "end",
                "depends_on": ["wait-1"],
                "required": True,
                "workspace_policy": "none",
                "status": "blocked",
            },
        ],
    }


def _issue(
    test_db: Session,
    *,
    project_id: str,
    user_id: int,
    item_id: str = "reg-issue-1",
) -> LoopItem:
    item = LoopItem(
        id=item_id,
        cloud_project_id=project_id,
        sequence_number=1,
        title="Issue with preset workflow",
        description="",
        status="in_progress",
        priority="none",
        sort_order=0,
        created_by_user_id=user_id,
        metadata_json={"workflow": _workflow_definition()},
    )
    test_db.add(item)
    test_db.commit()
    test_db.refresh(item)
    return item


def test_register_external_reference_via_api(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
) -> None:
    project = _project(test_client, test_token)
    item = _issue(
        test_db,
        project_id=str(project["id"]),
        user_id=test_user.id,
    )

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/external-references",
        headers=_auth(test_token),
        json={
            "provider": "gitlab",
            "opaque_ref": "acme/app!7",
            "item_id": item.id,
            "automation_run_id": "run-1",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "gitlab"
    assert body["opaque_ref"] == "acme/app!7"
    assert body["task_id"] == item.id
    assert body["issue_id"] == item.id
    assert body["workflow_node_id"] == "wait-1"
    binding = test_db.get(ExternalEventBinding, body["binding_id"])
    assert binding is not None
    assert binding.provider == "gitlab"
    assert binding.opaque_ref == "acme/app!7"
    assert binding.loop_item_id == item.id
    test_db.refresh(item)
    wait_node = next(
        node
        for node in item.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["status"] == "waiting"


def test_register_external_reference_requires_automation_run_id(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
) -> None:
    project = _project(test_client, test_token)
    item = _issue(
        test_db,
        project_id=str(project["id"]),
        user_id=test_user.id,
    )

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/external-references",
        headers=_auth(test_token),
        json={
            "provider": "gitlab",
            "opaque_ref": "acme/app!7",
            "item_id": item.id,
            "automation_run_id": "",
        },
    )

    assert response.status_code == 422


def test_register_external_reference_rejects_item_without_wait_node(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
) -> None:
    project = _project(test_client, test_token)
    item = _issue(
        test_db,
        project_id=str(project["id"]),
        user_id=test_user.id,
    )
    metadata = dict(item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    workflow["nodes"] = [node for node in workflow["nodes"] if node["id"] != "wait-1"]
    metadata["workflow"] = workflow
    item.metadata_json = metadata
    test_db.commit()

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/external-references",
        headers=_auth(test_token),
        json={
            "provider": "gitlab",
            "opaque_ref": "acme/app!7",
            "item_id": item.id,
            "automation_run_id": "run-1",
        },
    )

    assert response.status_code == 400
