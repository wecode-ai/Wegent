# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""A tag operation has a single transaction boundary across all references."""

from copy import deepcopy

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.services.loop_items.service import loop_item_service


@pytest.fixture
def tagged_board(test_client: TestClient, test_token: str) -> dict:
    headers = {"Authorization": f"Bearer {test_token}"}
    project = test_client.post(
        "/api/v1/cloud-projects", headers=headers, json={"name": "Atomic tags"}
    ).json()
    path = f"/api/v1/cloud-projects/{project['id']}"
    views = {
        "schema_version": 1,
        "default_view_id": "mixed",
        "future": {"keepCase": True},
        "views": [
            {
                "id": "mixed",
                "name": "Mixed",
                "columns": [
                    {"id": "status", "type": "status", "value": "inbox"},
                    {"id": "tag", "type": "tag", "value": "old", "extension": True},
                ],
                "filter": {"tags": ["old", "keep"], "match": "any"},
                "sorts": {"tag": ["created-desc"]},
            }
        ],
    }
    saved = test_client.patch(
        path,
        headers=headers,
        json={
            "version": project["version"],
            "tags": ["old", "keep"],
            "board_views": views,
        },
    )
    assert saved.status_code == 200, saved.text
    items = []
    for title, tags in [
        ("First", ["old", "keep"]),
        ("Second", ["old"]),
        ("Other", ["keep"]),
    ]:
        response = test_client.post(
            f"{path}/loop-items", headers=headers, json={"title": title, "tags": tags}
        )
        assert response.status_code == 201, response.text
        items.append(response.json())
    return {"project": saved.json(), "items": items, "path": path, "headers": headers}


def snapshot(db: Session, board: dict) -> list:
    db.expire_all()
    rows = [db.get(CloudProject, board["project"]["id"])]
    rows.extend(db.get(LoopItem, item["id"]) for item in board["items"])
    return [(row.version, deepcopy(row.metadata_json)) for row in rows]


@pytest.mark.parametrize("target", ["new", None])
def test_tag_change_updates_all_references_atomically(
    test_client: TestClient, test_db: Session, tagged_board: dict, target: str | None
) -> None:
    board = tagged_board
    before = snapshot(test_db, board)
    response = test_client.patch(
        board["path"],
        headers=board["headers"],
        json={
            "version": board["project"]["version"],
            "tag_change": {"source": "old", "target": target},
        },
    )
    assert response.status_code == 200, response.text
    project = response.json()
    expected = [target, "keep"] if target else ["keep"]
    assert project["tags"] == expected
    view = project["board_views"]["views"][0]
    assert view["filter"]["tags"] == expected
    assert project["board_views"]["future"] == {"keepCase": True}
    if target:
        assert view["columns"][1]["value"] == target
        assert view["columns"][1]["extension"] is True
        assert view["sorts"] == {"tag": ["created-desc"]}
    else:
        assert len(view["columns"]) == 1
        assert view["sorts"] == {}
    after = snapshot(test_db, board)
    assert [row[0] for row in after] == [
        before[0][0] + 1,
        before[1][0] + 1,
        before[2][0] + 1,
        before[3][0],
    ]
    assert after[1][1]["tags"] == expected
    assert after[2][1]["tags"] == ([target] if target else [])
    assert after[3] == before[3]


@pytest.mark.parametrize("target", ["new", None])
@pytest.mark.parametrize("failure", ["project_conflict", "second_issue"])
def test_tag_change_failure_rolls_back_every_reference(
    test_client: TestClient,
    test_db: Session,
    tagged_board: dict,
    monkeypatch: pytest.MonkeyPatch,
    target: str | None,
    failure: str,
) -> None:
    board = tagged_board
    if failure == "project_conflict":
        project = test_db.get(CloudProject, board["project"]["id"])
        project.version += 1
        test_db.commit()
    before = snapshot(test_db, board)
    update = loop_item_service.update
    calls = []

    def fail_after_first_write(*args, **kwargs):
        calls.append(args[1])
        if failure == "second_issue" and len(calls) == 2:
            raise HTTPException(409, "Issue changed")
        return update(*args, **kwargs)

    monkeypatch.setattr(loop_item_service, "update", fail_after_first_write)
    response = test_client.patch(
        board["path"],
        headers=board["headers"],
        json={
            "version": board["project"]["version"],
            "tag_change": {"source": "old", "target": target},
        },
    )
    assert response.status_code == 409, response.text
    assert len(calls) == (0 if failure == "project_conflict" else 2)
    assert snapshot(test_db, board) == before


def test_removing_the_only_lane_leaves_issues_untouched(
    test_client: TestClient, test_db: Session, tagged_board: dict
) -> None:
    board = tagged_board
    project = test_db.get(CloudProject, board["project"]["id"])
    metadata = deepcopy(project.metadata_json)
    metadata["board_views"]["views"][0]["columns"].pop(0)
    project.metadata_json = metadata
    test_db.commit()
    before = snapshot(test_db, board)
    response = test_client.patch(
        board["path"],
        headers=board["headers"],
        json={
            "version": project.version,
            "tag_change": {"source": "old", "target": None},
        },
    )
    assert response.status_code == 422, response.text
    assert snapshot(test_db, board) == before


@pytest.mark.parametrize(
    "operation",
    [
        {"tag_change": {"source": "old", "target": "x" * 33}},
        {"tag_change": {"source": "old"}},
        {"tag_change": {"source": "old", "target": " new "}},
        {"tag_change": {"source": "old", "target": "new"}, "tags": []},
    ],
)
def test_invalid_tag_operation_rejects_before_writing(
    test_client: TestClient, test_db: Session, tagged_board: dict, operation: dict
) -> None:
    board = tagged_board
    before = snapshot(test_db, board)
    response = test_client.patch(
        board["path"],
        headers=board["headers"],
        json={"version": board["project"]["version"], **operation},
    )
    assert response.status_code == 422, response.text
    assert snapshot(test_db, board) == before


@pytest.mark.parametrize("config", ["future", "duplicate", "external"])
def test_unsupported_tag_transaction_leaves_all_references_unchanged(
    test_client: TestClient, test_db: Session, tagged_board: dict, config: str
) -> None:
    board = tagged_board
    project = test_db.get(CloudProject, board["project"]["id"])
    metadata = deepcopy(project.metadata_json)
    if config == "future":
        metadata["board_views"]["schema_version"] = 2
    elif config == "duplicate":
        metadata["board_views"]["views"][0]["columns"].append(
            {"id": "new-tag", "type": "tag", "value": "new"}
        )
    else:
        metadata["task_provider"] = "github"
    project.metadata_json = metadata
    test_db.commit()
    before = snapshot(test_db, board)
    response = test_client.patch(
        board["path"],
        headers=board["headers"],
        json={
            "version": project.version,
            "tag_change": {"source": "old", "target": "new"},
        },
    )
    assert response.status_code == (409 if config == "future" else 422), response.text
    assert snapshot(test_db, board) == before
