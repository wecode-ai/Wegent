from datetime import datetime
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.resource_search import ResourceSearchResponse
from app.services.adapters.team_kinds import team_kinds_service
from app.services.resource_search import search_resources


def make_team(
    db: Session, owner_id: int, name: str, namespace: str = "default", **spec: Any
) -> Kind:
    team = Kind(
        user_id=owner_id,
        kind="Team",
        name=name,
        namespace=namespace,
        is_active=True,
        updated_at=datetime(2026, 9, 1),
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": namespace, "displayName": name},
            "spec": {"members": [], "collaborationModel": "solo", **spec},
        },
    )
    db.add(team)
    db.flush()
    return team


def search(
    db: Session, user_id: int, keyword: str = "agent", **options: Any
) -> ResourceSearchResponse:
    return search_resources(
        db,
        user_id=user_id,
        keyword=keyword,
        **{"scope": "all", "group_name": None, "limit": 100, "cursor": None, **options},
    )


def test_search_filters_before_pagination_and_hydrates_only_matches(
    test_db, test_user, monkeypatch
):
    target = make_team(test_db, test_user.id, "old-agent", description="代码开发")
    for index in range(205):
        make_team(test_db, test_user.id, f"new-{index}")
    converted = []
    original = team_kinds_service._convert_to_team_dict_with_cache

    def track(team, *args):
        converted.append(team.id)
        return original(team, *args)

    monkeypatch.setattr(team_kinds_service, "_convert_to_team_dict_with_cache", track)
    result = search(test_db, test_user.id, "开发", limit=1)

    assert [item["id"] for item in result.items] == [target.id]
    assert converted == [target.id]
    assert result.has_more is False


def test_cursor_returns_all_205_matches_without_count_queries(test_db, test_user):
    expected = [
        make_team(test_db, test_user.id, f"agent-{index}").id for index in range(205)
    ]
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement.lower())

    event.listen(test_db.bind, "before_cursor_execute", capture)
    try:
        ids = []
        cursor = None
        sizes = []
        while True:
            page = search(test_db, test_user.id, cursor=cursor)
            ids.extend(item["id"] for item in page.items)
            sizes.append(len(page.items))
            if not page.has_more:
                assert page.next_cursor is None
                break
            assert page.next_cursor != cursor
            cursor = page.next_cursor
    finally:
        event.remove(test_db.bind, "before_cursor_execute", capture)

    assert ids == list(reversed(expected))
    assert sizes == [100, 100, 5]
    assert not any("count(" in statement for statement in statements)


@pytest.mark.parametrize("keyword", ["开发", "DEVelop", "100%_done"])
def test_search_matches_literal_keywords_and_ignores_case(test_db, test_user, keyword):
    target = make_team(test_db, test_user.id, "开发-develop-100%_done")
    make_team(test_db, test_user.id, "100xyzAdone")

    result = search(test_db, test_user.id, keyword)

    assert [item["id"] for item in result.items] == [target.id]


def test_search_does_not_expose_private_or_inactive_agents(test_db, test_user):
    owner = User(
        user_name="other-owner",
        password_hash="unused",
        email="other@test.local",
        role="user",
    )
    test_db.add(owner)
    test_db.flush()
    own = make_team(test_db, test_user.id, "own-agent")
    public = make_team(test_db, 0, "public-agent")
    shared = make_team(test_db, owner.id, "shared-agent")
    make_team(test_db, owner.id, "private-agent")
    inactive = make_team(test_db, test_user.id, "inactive-agent")
    inactive.is_active = False
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=shared.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Reporter",
            status="approved",
            invited_by_user_id=owner.id,
        )
    )
    test_db.flush()

    result = search(test_db, test_user.id)

    assert {item["id"] for item in result.items} == {own.id, public.id, shared.id}
    owned = search(test_db, test_user.id, owned_only=True)
    assert [item["id"] for item in owned.items] == [own.id]


def test_search_requires_group_permission(test_db, test_user):
    group = Namespace(
        name="private-group",
        display_name="Private",
        owner_user_id=999,
        visibility="private",
        is_active=True,
    )
    test_db.add(group)
    test_db.flush()
    target = make_team(test_db, 999, "group-agent", namespace=group.name)
    with pytest.raises(HTTPException) as error:
        search(test_db, test_user.id, scope="group", group_name=group.name)
    assert error.value.status_code == 403

    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Reporter",
            status="approved",
            invited_by_user_id=999,
        )
    )
    test_db.flush()
    result = search(test_db, test_user.id, scope="group", group_name=group.name)
    assert [item["id"] for item in result.items] == [target.id]


@pytest.mark.parametrize(
    "options", [{"cursor": "invalid"}, {"keyword": ""}, {"keyword": "  "}]
)
def test_search_rejects_invalid_input(test_db, test_user, options):
    with pytest.raises(HTTPException) as error:
        search(test_db, test_user.id, **options)
    assert error.value.status_code in (400, 422)


@pytest.fixture
def teams_client(test_db, test_user):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.dependencies import get_db
    from app.api.endpoints.adapter.teams import router
    from app.core.security import get_current_user

    app = FastAPI()
    app.include_router(router, prefix="/teams")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: test_user
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize(
    "size,page,returned,count_queries",
    [
        (0, 1, 0, 0),
        (91, 1, 91, 0),
        (195, 1, 100, 1),
        (195, 2, 95, 0),
        (195, 3, 0, 1),
        (200, 2, 100, 1),
    ],
)
def test_team_page_resolves_permissions_once_and_counts_only_when_needed(
    test_db,
    test_user,
    teams_client,
    mocker,
    size,
    page,
    returned,
    count_queries,
):
    from app.services import group_permission

    for index in range(size):
        make_team(test_db, test_user.id, f"agent-{index}")
    roles = mocker.spy(group_permission, "get_user_group_roles")
    authorization = mocker.spy(
        team_kinds_service, "_get_accessible_authorization_namespace_ids"
    )
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement.lower())

    event.listen(test_db.bind, "before_cursor_execute", capture)
    try:
        response = teams_client.get(
            "/teams", params={"page": page, "limit": 100, "scope": "all"}
        )
    finally:
        event.remove(test_db.bind, "before_cursor_execute", capture)

    assert response.status_code == 200
    assert response.json()["total"] == size
    assert len(response.json()["items"]) == returned
    assert roles.call_count == 1
    assert authorization.call_count == 1
    assert sum("count(" in statement for statement in statements) == count_queries


def test_team_page_refreshes_group_permissions_on_each_request(
    test_db, test_user, teams_client, mocker
):
    from app.services import group_permission

    group = Namespace(
        name="revocable-group",
        display_name="Revocable group",
        owner_user_id=999,
        visibility="private",
        is_active=True,
    )
    test_db.add(group)
    test_db.flush()
    membership = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="user",
        entity_id=str(test_user.id),
        role="Reporter",
        status="approved",
        invited_by_user_id=999,
    )
    test_db.add(membership)
    for index in range(2):
        make_team(test_db, 999, f"group-agent-{index}", namespace=group.name)
    roles = mocker.spy(group_permission, "get_user_group_roles")
    params = {"limit": 1, "scope": "all", "source_filter": "group"}
    before = teams_client.get("/teams", params=params)
    assert before.status_code == 200
    assert before.json()["total"] == 2
    assert len(before.json()["items"]) == 1

    test_db.delete(membership)
    test_db.flush()
    after = teams_client.get("/teams", params=params)
    assert after.status_code == 200
    assert after.json() == {"total": 0, "items": []}
    assert roles.call_count == 2


def test_team_list_pages_all_205_agents_with_filtered_totals(
    test_db, test_user, teams_client
):
    expected = [
        make_team(test_db, test_user.id, f"agent-{index}", bind_mode=["task"]).id
        for index in range(205)
    ]
    for index in range(105):
        make_team(test_db, 0, f"public-{index}", bind_mode=["task"])
        make_team(test_db, test_user.id, f"chat-{index}", bind_mode=["chat"])
    make_team(test_db, test_user.id, "hidden", bind_mode=[])
    pages = []
    for page in [1, 2, 3, 4]:
        response = teams_client.get(
            "/teams",
            params={
                "page": page,
                "limit": 100,
                "scope": "all",
                "source_filter": "mine",
                "mode": "task",
            },
        )
        assert response.status_code == 200
        result = response.json()
        assert result["total"] == 205
        pages.append(result["items"])
    assert [len(items) for items in pages] == [100, 100, 5, 0]
    assert [item["id"] for items in pages for item in items] == list(reversed(expected))


def test_source_and_mode_filter_before_pagination(test_db, test_user):
    target = make_team(test_db, test_user.id, "older-device", bind_mode=["task"])
    for index in range(105):
        make_team(test_db, 0, f"public-{index}", bind_mode=["task"])
        make_team(test_db, test_user.id, f"chat-{index}", bind_mode=["chat"])
    make_team(test_db, test_user.id, "hidden-device", bind_mode=[])
    result = search(
        test_db, test_user.id, keyword="device", source_filter="mine", mode="task"
    )
    assert [item["id"] for item in result.items] == [target.id]
    assert not result.has_more


def test_multiple_groups_share_one_page_and_require_access(
    test_db, test_user, teams_client
):
    for name in ["group-a", "group-b"]:
        group = Namespace(
            name=name,
            display_name=name,
            owner_user_id=test_user.id,
            visibility="private",
            is_active=True,
        )
        test_db.add(group)
        test_db.flush()
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type="user",
                entity_id=str(test_user.id),
                role="Owner",
                status="approved",
                invited_by_user_id=test_user.id,
            )
        )
        for index in range(60):
            make_team(test_db, test_user.id, f"{name}-{index}", namespace=name)
    first = search(
        test_db,
        test_user.id,
        keyword="group",
        scope="group",
        group_names=["group-a", "group-b"],
    )
    assert len(first.items) == 100
    second = search(
        test_db,
        test_user.id,
        keyword="group",
        scope="group",
        group_names=["group-a", "group-b"],
        cursor=first.next_cursor,
    )
    assert len(second.items) == 20
    assert not second.has_more
    with pytest.raises(HTTPException) as error:
        search(
            test_db,
            test_user.id,
            keyword="group",
            scope="group",
            group_names=["group-a", "unauthorized"],
        )
    assert error.value.status_code == 403
    ids = []
    for page, size in [(1, 100), (2, 20)]:
        response = teams_client.get(
            "/teams",
            params={
                "page": page,
                "limit": 100,
                "scope": "group",
                "group_names": ["group-a", "group-b"],
                "source_filter": "group",
                "mode": "all",
            },
        )
        assert response.status_code == 200
        result = response.json()
        assert result["total"] == 120
        assert len(result["items"]) == size
        ids.extend(item["id"] for item in result["items"])
    assert len(set(ids)) == 120
    denied = teams_client.get(
        "/teams",
        params={"scope": "group", "group_names": ["group-a", "unauthorized"]},
    )
    assert denied.status_code == 403


def test_team_list_total_matches_shared_agents(test_db, test_user, teams_client):
    own = make_team(test_db, test_user.id, "own-agent")
    make_team(test_db, 0, "public-agent")
    shared = make_team(test_db, 999, "shared-agent")
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=shared.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Reporter",
            status="approved",
            invited_by_user_id=999,
        )
    )
    test_db.flush()
    response = teams_client.get(
        "/teams", params={"limit": 1, "source_filter": "group", "mode": "all"}
    )
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [item["id"] for item in response.json()["items"]] == [shared.id]
    assert own.id != shared.id


def test_resource_search_endpoint_validates_and_returns_managed_agents(
    test_db, test_user
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.dependencies import get_db
    from app.api.endpoints.resource_library import router
    from app.core.security import get_current_user

    target = make_team(test_db, test_user.id, "开发-agent")
    app = FastAPI()
    app.include_router(router, prefix="/resource-library")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: test_user
    client = TestClient(app)

    response = client.get(
        "/resource-library/search",
        params={"keyword": "开发", "resource_type": "agent", "limit": 1},
    )

    assert response.status_code == 200
    assert response.json()["items"][0]["id"] == target.id
    assert "total" not in response.json()
    for params in [
        {"keyword": ""},
        {"keyword": "  "},
        {"limit": 101},
        {"limit": 0},
        {"resource_type": "skill"},
        {"scope": "unknown"},
        {"keyword": "x" * 201},
    ]:
        invalid = client.get(
            "/resource-library/search", params={"keyword": "开发", **params}
        )
        assert invalid.status_code == 422


def test_personal_search_uses_scoped_index(test_db, test_user):
    make_team(test_db, test_user.id, "开发-agent")
    for index in range(200):
        make_team(test_db, test_user.id, f"unmatched-{index}")
    statements = []

    def capture(_conn, _cursor, statement, parameters, _context, _many):
        if "access_row_number" in statement:
            statements.append((statement, parameters))

    event.listen(test_db.bind, "before_cursor_execute", capture)
    try:
        result = search(test_db, test_user.id, "开发", scope="personal")
    finally:
        event.remove(test_db.bind, "before_cursor_execute", capture)

    assert len(result.items) == 1
    statement, parameters = statements[0]
    plan = (
        test_db.connection()
        .exec_driver_sql("EXPLAIN QUERY PLAN " + statement, parameters)
        .all()
    )
    assert any("ix_kinds_user_kind_ns_active" in row[-1] for row in plan)
