# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Saved views reuse project CAS and authorization without migrating Issues."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.delivery import CloudProject, LoopItem
from app.models.resource_member import ResourceMember
from app.models.user import User


@pytest.mark.parametrize("character", ["a", "标", "😀"])
def test_tag_boundaries_preserve_lane_and_filter_matches(
    test_client: TestClient, test_token: str, character: str
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    tag = character * 32
    oversized = tag + character
    project = test_client.post(
        "/api/v1/cloud-projects", headers=headers, json={"name": "Tag boundaries"}
    ).json()
    path = f"/api/v1/cloud-projects/{project['id']}"
    read_path = f"/api/v1/projects/{project['id']}"
    config = {
        "schema_version": 1,
        "views": [
            {
                "id": "boundary",
                "name": "Boundary",
                "columns": [{"id": "tag", "type": "tag", "value": tag}],
                "filter": {"tags": [tag], "match": "all"},
            }
        ],
    }
    saved = test_client.patch(
        path,
        headers=headers,
        json={
            "version": project["version"],
            "tags": [tag],
            "board_views": config,
        },
    )
    assert saved.status_code == 200, saved.text
    project = saved.json()
    created = test_client.post(
        f"{path}/loop-items",
        headers=headers,
        json={
            "title": "Boundary",
            "tags": [tag],
        },
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    item_path = f"/api/v1/loop-items/{issue['id']}"
    moved = test_client.patch(
        item_path,
        headers=headers,
        json={
            "version": issue["version"],
            "tags": [tag],
        },
    )
    assert moved.status_code == 200, moved.text
    persisted = test_client.get(item_path, headers=headers).json()
    view = test_client.get(read_path, headers=headers).json()["board_views"]["views"][0]
    assert persisted["tags"] == [view["columns"][0]["value"]] == view["filter"]["tags"]
    for fields in [
        {"tags": [oversized]},
        {
            "board_views": {
                "views": [
                    {
                        "id": "bad",
                        "name": "Untrimmed lane",
                        "columns": [{"id": "tag", "type": "tag", "value": " tag "}],
                    }
                ]
            }
        },
        {
            "board_views": {
                "views": [
                    {
                        "id": "bad",
                        "name": "Untrimmed filter",
                        "columns": [{"id": "tag", "type": "tag", "value": tag}],
                        "filter": {"tags": [" tag "]},
                    }
                ]
            }
        },
        {
            "board_views": {
                "views": [
                    {
                        "id": "bad",
                        "name": "Bad lane",
                        "columns": [{"id": "tag", "type": "tag", "value": oversized}],
                    }
                ]
            }
        },
        {
            "board_views": {
                "views": [
                    {
                        "id": "bad",
                        "name": "Bad filter",
                        "columns": [{"id": "tag", "type": "tag", "value": tag}],
                        "filter": {"tags": [oversized]},
                    }
                ]
            }
        },
    ]:
        response = test_client.patch(
            path,
            headers=headers,
            json={
                "version": project["version"],
                **fields,
            },
        )
        assert response.status_code == 422, response.text
    rejected_create = test_client.post(
        f"{path}/loop-items",
        headers=headers,
        json={
            "title": "Rejected",
            "tags": [oversized],
        },
    )
    assert rejected_create.status_code == 422, rejected_create.text
    rejected_update = test_client.patch(
        item_path,
        headers=headers,
        json={
            "version": persisted["version"],
            "tags": [oversized],
        },
    )
    assert rejected_update.status_code == 422, rejected_update.text
    assert test_client.get(item_path, headers=headers).json() == persisted
    unchanged = test_client.get(read_path, headers=headers).json()
    assert (unchanged["version"], unchanged["tags"], unchanged["board_views"]) == (
        project["version"],
        [tag],
        project["board_views"],
    )


def test_views_preserve_history_extensions_and_old_client_writes(
    test_client: TestClient, test_db: Session, test_token: str
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    project = test_client.post(
        "/api/v1/cloud-projects", headers=headers, json={"name": "Views"}
    ).json()
    path = f"/api/v1/cloud-projects/{project['id']}"
    issue = test_client.post(
        f"{path}/loop-items",
        headers=headers,
        json={"title": "Historical", "status": "completed", "tags": ["a", "b"]},
    ).json()
    config = {
        "schema_version": 1,
        "default_view_id": "mixed",
        "futureExtension": {"keepCase": True},
        "views": [
            {
                "id": "mixed",
                "name": "Mixed",
                "columns": [
                    {"id": "status", "type": "status", "value": "completed"},
                    {"id": "tag", "type": "tag", "value": "a", "futureField": 7},
                ],
                "filter": {"tags": ["b"], "match": "all"},
                "sorts": {"tag": ["created-asc"]},
            }
        ],
    }
    saved = test_client.patch(
        path,
        headers=headers,
        json={"version": project["version"], "board_views": config},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["board_views"] == config
    invalid = test_client.patch(
        path,
        headers=headers,
        json={
            "version": saved.json()["version"],
            "board_views": {**config, "default_view_id": "missing"},
            "card_display": {
                "show_assignee": False,
                "show_priority": False,
                "show_tags": False,
                "show_date": False,
            },
        },
    )
    assert invalid.status_code == 422
    unchanged = test_client.get(
        f"/api/v1/projects/{project['id']}", headers=headers
    ).json()
    assert unchanged["version"] == saved.json()["version"]
    assert unchanged["board_views"] == config
    assert unchanged["card_display"] == saved.json()["card_display"]
    stale = test_client.patch(
        path,
        headers=headers,
        json={
            "version": project["version"],
            "board_views": {"schema_version": 1, "views": []},
        },
    )
    assert stale.status_code == 409
    old_write = test_client.patch(
        path,
        headers=headers,
        json={
            "version": saved.json()["version"],
            "board_config": project["board_config"],
            "tags": ["new"],
        },
    )
    assert old_write.status_code == 200, old_write.text
    assert (
        test_client.get(f"/api/v1/projects/{project['id']}", headers=headers).json()[
            "board_views"
        ]
        == config
    )
    historical = test_client.get(
        f"/api/v1/loop-items/{issue['id']}", headers=headers
    ).json()
    assert (historical["status"], historical["tags"], historical["version"]) == (
        "completed",
        ["a", "b"],
        issue["version"],
    )
    row = (
        test_db.query(CloudProject).filter(CloudProject.id == int(project["id"])).one()
    )
    row.metadata_json = {
        **row.metadata_json,
        "board_views": {"schema_version": 2, "future": True},
    }
    test_db.commit()
    future = test_client.patch(
        path,
        headers=headers,
        json={"version": old_write.json()["version"], "board_views": config},
    )
    assert future.status_code == 409
    assert test_client.get(f"/api/v1/projects/{project['id']}", headers=headers).json()[
        "board_views"
    ] == {"schema_version": 2, "future": True}


def test_historical_long_tags_survive_reads_and_unrelated_writes(
    test_client: TestClient, test_db: Session, test_token: str
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    project = test_client.post(
        "/api/v1/cloud-projects", headers=headers, json={"name": "Historical tags"}
    ).json()
    path = f"/api/v1/cloud-projects/{project['id']}"
    issue = test_client.post(
        f"{path}/loop-items", headers=headers, json={"title": "Historical"}
    ).json()
    tag = "historical" * 4
    for model, item_id in [(CloudProject, project["id"]), (LoopItem, issue["id"])]:
        row = test_db.query(model).filter(model.id == item_id).one()
        row.metadata_json = {**row.metadata_json, "tags": [tag]}
    test_db.commit()
    renamed = test_client.patch(
        path,
        headers=headers,
        json={"version": project["version"], "name": "Renamed project"},
    )
    assert renamed.status_code == 200, renamed.text
    updated = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=headers,
        json={"version": issue["version"], "title": "Renamed Issue"},
    )
    assert updated.status_code == 200, updated.text
    assert renamed.json()["tags"] == updated.json()["tags"] == [tag]
    assert test_client.get(f"/api/v1/projects/{project['id']}", headers=headers).json()[
        "tags"
    ] == [tag]
    assert test_client.get(f"/api/v1/loop-items/{issue['id']}", headers=headers).json()[
        "tags"
    ] == [tag]


@pytest.mark.parametrize("role", ["Developer", "Viewer"])
@pytest.mark.parametrize("field", ["board_views", "tag_change"])
def test_only_project_administrators_can_save_views(
    test_client: TestClient, test_db: Session, test_token: str, role: str, field: str
) -> None:
    owner = {"Authorization": f"Bearer {test_token}"}
    project = test_client.post(
        "/api/v1/cloud-projects", headers=owner, json={"name": "Views"}
    ).json()
    user = User(
        user_name=f"view-{role}",
        email=f"view-{role}@example.com",
        password_hash="unused",
    )
    test_db.add(user)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="CloudProject",
            resource_id=int(project["id"]),
            entity_type="user",
            entity_id=str(user.id),
            user_id=user.id,
            role=role,
            status="approved",
        )
    )
    test_db.commit()
    headers = {
        "Authorization": f"Bearer {create_access_token(data={'sub': user.user_name})}"
    }
    result = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=headers,
        json={
            "version": project["version"],
            field: (
                {"schema_version": 1, "views": []}
                if field == "board_views"
                else {"source": "old", "target": "new"}
            ),
        },
    )
    assert result.status_code == 403
