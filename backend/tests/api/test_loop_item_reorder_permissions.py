# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CP07/CP13/CP14: ordering shares Issue visibility across HTTP and MCP."""

from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.resource_member import ResourceMember
from app.models.user import User
from tests.api.test_deliveries_api import _auth, delivery_project

Reorder = Callable[[dict[str, Any]], tuple[int, list[dict[str, Any]]]]


@dataclass
class OrderingScope:
    project: CloudProject
    user: User
    grant: ResourceMember
    headers: dict[str, str]
    items: list[LoopItem]


@pytest.fixture(params=["open", "related"])
def ordering_scope(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    request: pytest.FixtureRequest,
) -> OrderingScope:
    user = User(
        user_name="ordering-member",
        password_hash="unused",
        email="ordering-member@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.flush()
    grant = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=delivery_project.id,
        entity_id=str(user.id),
        role="Developer",
        status="approved",
    )
    test_db.add(grant)
    delivery_project.metadata_json = {"default_issue_security": request.param}
    definitions = [
        ("first", user.id, "inbox", {}),
        ("private-same", test_user.id, "inbox", {"security_level": "related"}),
        ("second", user.id, "inbox", {}),
        (
            "private-other",
            test_user.id,
            "completed",
            {} if request.param == "related" else {"security_level": "related"},
        ),
        ("public", test_user.id, "inbox", {"security_level": "open"}),
    ]
    items = [
        LoopItem(
            cloud_project_id=delivery_project.id,
            title=title,
            status=state,
            priority="high",
            sequence_number=index + 1,
            sort_order=index,
            created_by_user_id=creator,
            metadata_json=metadata,
        )
        for index, (title, creator, state, metadata) in enumerate(definitions)
    ]
    test_db.add_all(items)
    test_db.commit()
    return OrderingScope(
        delivery_project,
        user,
        grant,
        _auth(create_access_token(data={"sub": user.user_name})),
        items,
    )


@pytest.fixture(params=["http", "mcp"])
def reorder(
    test_client: TestClient,
    test_db: Session,
    ordering_scope: OrderingScope,
    monkeypatch: pytest.MonkeyPatch,
    request: pytest.FixtureRequest,
) -> Reorder:
    scope = ordering_scope
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: nullcontext(test_db))

    def perform(values: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
        if request.param == "http":
            response = test_client.post(
                f"/api/v1/cloud-projects/{scope.project.id}/loop-items/reorder",
                headers=scope.headers,
                json=values,
            )
            return response.status_code, response.json().get("items", [])
        token = MCPAuthInfo(
            user_id=scope.user.id, user_name=scope.user.user_name, auth_type="user"
        )
        try:
            return 200, wework_space.reorder_board_items(
                token, values, space_id=str(scope.project.id)
            )
        except HTTPException as error:
            return error.status_code, []

    return perform


def snapshot(db: Session, project: CloudProject) -> list[tuple]:
    db.expire_all()
    return [
        (item.id, item.sort_order, item.version, item.status, item.metadata_json)
        for item in db.query(LoopItem)
        .filter_by(cloud_project_id=project.id)
        .order_by(LoopItem.sort_order, LoopItem.id)
    ]


@pytest.mark.parametrize("status_scope", [None, "inbox"])
@pytest.mark.parametrize("role", ["Developer", "Maintainer", "Viewer"])
def test_cp07_cp13_cp14_reorder_projects_only_authorized_sibling_slots(
    test_client: TestClient,
    test_db: Session,
    ordering_scope: OrderingScope,
    reorder: Reorder,
    status_scope: str | None,
    role: str,
) -> None:
    scope = ordering_scope
    scope.grant.role = role
    test_db.commit()
    first, private_same, second, private_other, public = scope.items
    before = snapshot(test_db, scope.project)
    status, returned = reorder(
        {
            "status": status_scope,
            "item_ids": [second.id, first.id],
        }
    )
    if role == "Viewer":
        assert status == 403
        assert snapshot(test_db, scope.project) == before
        return
    assert status == 200
    assert all(item["can_view_detail"] for item in returned)
    expected = [second.id, first.id, public.id]
    if role == "Maintainer":
        expected = [second.id, first.id, private_same.id]
        if status_scope is None:
            expected.append(private_other.id)
        expected.append(public.id)
    assert [item["id"] for item in returned] == expected
    after = snapshot(test_db, scope.project)
    assert [row[1] for row in after] == list(range(5))
    expected_global = [
        second.id,
        first.id,
        private_same.id,
        private_other.id,
        public.id,
    ]
    if role == "Developer":
        expected_global = [
            second.id,
            private_same.id,
            first.id,
            private_other.id,
            public.id,
        ]
    assert [row[0] for row in after] == expected_global
    original = {row[0]: row for row in before}
    for row in after:
        assert row[3:] == original[row[0]][3:]
        assert row[2] == original[row[0]][2] + (row[1] != original[row[0]][1])
    if role == "Developer":
        for hidden in (private_same, private_other):
            assert next(row for row in after if row[0] == hidden.id) == next(
                row for row in before if row[0] == hidden.id
            )
            assert (
                test_client.get(
                    f"/api/v1/loop-items/{hidden.id}", headers=scope.headers
                ).status_code
                == 404
            )
        listed = test_client.get(
            f"/api/v1/cloud-projects/{scope.project.id}/loop-items",
            headers=scope.headers,
        )
        assert [item["id"] for item in listed.json()["items"]] == expected


@pytest.mark.parametrize("status_scope", [None, "inbox"])
@pytest.mark.parametrize(
    "target", ["private-same", "private-other", "missing", "deleted"]
)
def test_cp13_cp14_reorder_rejects_inaccessible_ids_before_any_write(
    test_db: Session,
    ordering_scope: OrderingScope,
    reorder: Reorder,
    status_scope: str | None,
    target: str,
) -> None:
    scope = ordering_scope
    denied = next((item.id for item in scope.items if item.title == target), "missing")
    if target == "deleted":
        scope.items[4].deleted_at = datetime.now()
        denied = scope.items[4].id
        test_db.commit()
    before = snapshot(test_db, scope.project)
    status, returned = reorder(
        {
            "status": status_scope,
            "item_ids": [scope.items[2].id, denied, scope.items[0].id],
        }
    )
    assert status == 404
    assert returned == []
    assert snapshot(test_db, scope.project) == before
