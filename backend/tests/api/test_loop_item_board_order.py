# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.resource_member import ResourceMember
from app.models.user import User
from tests.api.test_deliveries_api import _auth, delivery_project


def create_item(
    client: TestClient, project: CloudProject, token: str, **values: Any
) -> dict:
    response = client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items",
        headers=_auth(token),
        json={"title": "Board item", **values},
    )
    assert response.status_code == 201
    return response.json()


def listed(client: TestClient, project: CloudProject, token: str) -> list[dict]:
    response = client.get(
        f"/api/v1/cloud-projects/{project.id}/loop-items", headers=_auth(token)
    )
    assert response.status_code == 200
    return response.json()["items"]


def test_position_and_status_reorder_keep_one_global_order(
    test_client: TestClient, test_token: str, delivery_project: CloudProject
) -> None:
    items = [
        create_item(
            test_client,
            delivery_project,
            test_token,
            status=state,
            priority="high",
            title=title,
        )
        for title, state in [("A", "pending"), ("B", "completed"), ("C", "pending")]
    ]
    path = f"/api/v1/cloud-projects/{delivery_project.id}/loop-items/reorder"
    response = test_client.post(
        path,
        headers=_auth(test_token),
        json={
            "status": None,
            "item_ids": [item["id"] for item in items],
        },
    )
    assert response.status_code == 200
    first, _, last = response.json()["items"]
    moved = test_client.patch(
        f"/api/v1/loop-items/{last['id']}",
        headers=_auth(test_token),
        json={
            "version": last["version"],
            "position": {"before_item_id": first["id"]},
        },
    )
    assert moved.status_code == 200
    assert moved.json()["version"] == last["version"] + 1
    assert [
        (item["title"], item["sort_order"])
        for item in listed(test_client, delivery_project, test_token)
    ] == [("C", 0), ("A", 1), ("B", 2)]
    response = test_client.post(
        path,
        headers=_auth(test_token),
        json={
            "status": "pending",
            "item_ids": [first["id"], last["id"]],
        },
    )
    assert response.status_code == 200
    assert [
        (item["title"], item["sort_order"])
        for item in listed(test_client, delivery_project, test_token)
    ] == [("A", 0), ("C", 1), ("B", 2)]
    current = response.json()["items"][0]
    response = test_client.patch(
        f"/api/v1/loop-items/{current['id']}",
        headers=_auth(test_token),
        json={
            "version": current["version"],
            "position": {"before_item_id": None},
        },
    )
    assert response.status_code == 200
    assert [
        item["title"] for item in listed(test_client, delivery_project, test_token)
    ] == ["C", "B", "A"]


def test_position_has_no_project_size_limit_and_preserves_other_fields(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    test_db: Session,
    test_user: User,
) -> None:
    items = [
        LoopItem(
            cloud_project_id=delivery_project.id,
            title=f"Item {index}",
            status="completed" if index == 1 else "pending",
            priority="high" if index < 2 else "low",
            sequence_number=index + 1,
            sort_order=index,
            created_by_user_id=test_user.id,
            metadata_json={"tags": ["backend", "shared"]},
        )
        for index in range(1001)
    ]
    test_db.add_all(items)
    test_db.commit()
    moved, anchor = items[1], items[0]
    response = test_client.patch(
        f"/api/v1/loop-items/{moved.id}",
        headers=_auth(test_token),
        json={
            "version": moved.version,
            "priority": "urgent",
            "position": {"before_item_id": anchor.id},
        },
    )
    assert response.status_code == 200
    saved = response.json()
    assert saved["sort_order"] == 0
    assert saved["status"] == "completed"
    assert saved["tags"] == ["backend", "shared"]
    assert saved["priority"] == "urgent"
    persisted = listed(test_client, delivery_project, test_token)
    assert len(persisted) == 1001
    assert [item["id"] for item in persisted[:2]] == [moved.id, anchor.id]
    assert [item["sort_order"] for item in persisted] == list(range(1001))


@pytest.mark.parametrize("failure", ["foreign_anchor", "stale_version", "write_error"])
def test_failed_position_never_partially_saves_group_fields(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    first = create_item(test_client, delivery_project, test_token, priority="high")
    child = create_item(
        test_client, delivery_project, test_token, parent_id=first["id"]
    )
    anchor = child["id"] if failure == "foreign_anchor" else None
    if failure == "write_error":

        def fail_write(*args: Any, **kwargs: Any) -> None:
            raise HTTPException(503, "Ordering write failed")

        monkeypatch.setattr(
            "app.services.loop_items.service.persist_sibling_order", fail_write
        )
    response = test_client.patch(
        f"/api/v1/loop-items/{first['id']}",
        headers=_auth(test_token),
        json={
            "version": first["version"] + (1 if failure == "stale_version" else 0),
            "priority": "low",
            "tags": ["moved"],
            "position": {"before_item_id": anchor},
        },
    )
    assert (
        response.status_code
        == {"foreign_anchor": 422, "stale_version": 409, "write_error": 503}[failure]
    )
    test_db.rollback()
    saved = test_client.get(
        f"/api/v1/loop-items/{first['id']}", headers=_auth(test_token)
    ).json()
    assert saved["priority"] == first["priority"]
    assert saved["tags"] == first["tags"]
    assert saved["sort_order"] == first["sort_order"]
    assert saved["version"] == first["version"]


def test_assignment_and_position_are_saved_together(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    test_user: User,
) -> None:
    first = create_item(test_client, delivery_project, test_token)
    second = create_item(test_client, delivery_project, test_token)
    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items/{second['id']}/assign",
        headers=_auth(test_token),
        json={
            "version": second["version"],
            "assigneeType": "user",
            "assigneeId": str(test_user.id),
            "notifyAssignee": False,
            "position": {"beforeItemId": first["id"]},
        },
    )
    assert response.status_code == 200
    assert response.json()["assignee_user_id"] == test_user.id
    assert [
        item["id"] for item in listed(test_client, delivery_project, test_token)
    ] == [second["id"], first["id"]]


@pytest.mark.parametrize("operation", ["update", "assign"])
def test_position_anchor_cannot_reveal_an_unrelated_private_issue(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    test_db: Session,
    operation: str,
) -> None:
    hidden = create_item(test_client, delivery_project, test_token)
    protected = test_client.patch(
        f"/api/v1/loop-items/{hidden['id']}",
        headers=_auth(test_token),
        json={"version": hidden["version"], "security_level": "related"},
    )
    assert protected.status_code == 200
    member = User(
        user_name="board-member",
        password_hash="unused",
        email="board-member@example.com",
        is_active=True,
    )
    test_db.add(member)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=delivery_project.id,
            entity_id=str(member.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.commit()
    token = create_access_token(data={"sub": member.user_name})
    moved = create_item(test_client, delivery_project, token)
    assert (
        test_client.get(
            f"/api/v1/loop-items/{hidden['id']}", headers=_auth(token)
        ).status_code
        == 404
    )
    position = {"beforeItemId": hidden["id"]}
    if operation == "update":
        response = test_client.patch(
            f"/api/v1/loop-items/{moved['id']}",
            headers=_auth(token),
            json={
                "version": moved["version"],
                "priority": "urgent",
                "position": position,
            },
        )
    else:
        response = test_client.post(
            f"/api/v1/cloud-projects/{delivery_project.id}/loop-items/{moved['id']}/assign",
            headers=_auth(token),
            json={
                "version": moved["version"],
                "assigneeType": "user",
                "assigneeId": str(member.id),
                "position": position,
            },
        )
    assert response.status_code == 404
    saved = test_client.get(
        f"/api/v1/loop-items/{moved['id']}", headers=_auth(token)
    ).json()
    assert saved["priority"] == moved["priority"]
    assert saved["version"] == moved["version"]


@pytest.mark.parametrize("provider", ["github", "gitlab"])
def test_external_provider_rejects_position_instead_of_silently_ignoring_it(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    test_db: Session,
    provider: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivery_project.metadata_json = {
        "task_provider": provider,
        "provider_config": {"repository": "owner/repo"},
    }
    test_db.commit()

    def unexpected_request(*args: Any, **kwargs: Any) -> None:
        raise AssertionError(
            "Position-only changes must not contact the upstream provider"
        )

    monkeypatch.setattr(
        "app.services.loop_items.external_provider.external_loop_item_provider._get_issue",
        unexpected_request,
    )
    response = test_client.patch(
        f"/api/v1/loop-items/{delivery_project.project_key}-9001",
        headers=_auth(test_token),
        json={"version": 1, "priority": "urgent", "position": {"beforeItemId": None}},
    )
    assert response.status_code == 409
    assert (
        response.json()["detail"]
        == "Manual ordering is not supported by this Issue provider"
    )
