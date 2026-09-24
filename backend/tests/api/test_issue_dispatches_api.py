# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.user import User


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_direct_dispatch_api_create_get_list_and_cancel_task(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"DAPI{uuid.uuid4().hex[:6].upper()}",
        name="Dispatch API",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        next_item_number=2,
    )
    test_db.add(project)
    test_db.flush()
    issue = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        sequence_number=1,
        title="API dispatch",
        status="inbox",
        priority="medium",
        created_by_user_id=test_user.id,
    )
    test_db.add(issue)
    test_db.commit()

    created = test_client.post(
        f"/api/v1/loop-items/{issue.id}/dispatches",
        headers=_auth(test_token),
        json={
            "target_type": "human",
            "target_id": str(test_user.id),
            "idempotency_key": "api-human",
            "task_title": "Review API evidence",
            "instructions": "Review the evidence.",
        },
    )
    assert created.status_code == 201
    payload = created.json()
    assert payload["project_id"] == str(project.id)
    assert payload["execution_location"] == "human"
    assert payload["manager_turn_count"] == 0
    task_id = payload["rounds"][0]["tasks"][0]["id"]

    fetched = test_client.get(
        f"/api/v1/issue-dispatches/{payload['id']}",
        headers=_auth(test_token),
    )
    assert fetched.status_code == 200
    assert fetched.json()["id"] == payload["id"]

    listed = test_client.get(
        f"/api/v1/loop-items/{issue.id}/dispatches",
        headers=_auth(test_token),
    )
    assert listed.status_code == 200
    assert [value["id"] for value in listed.json()["items"]] == [payload["id"]]

    cancelled = test_client.post(
        f"/api/v1/issue-dispatch-tasks/{task_id}/cancel",
        headers=_auth(test_token),
        json={"reason": "No longer needed."},
    )
    assert cancelled.status_code == 200
    cancelled_payload = cancelled.json()
    assert cancelled_payload["status"] == "active"
    assert cancelled_payload["rounds"][0]["tasks"][0]["status"] == "cancelled"

    retried = test_client.post(
        f"/api/v1/issue-dispatches/{payload['id']}/retry",
        headers=_auth(test_token),
        json={},
    )
    assert retried.status_code == 200
    retried_payload = retried.json()
    assert len(retried_payload["rounds"]) == 2
    assert retried_payload["rounds"][1]["tasks"][0]["status"] == "assigned"
