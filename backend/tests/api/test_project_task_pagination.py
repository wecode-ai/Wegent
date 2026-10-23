# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project task pages stay bounded and preserve project visibility filters."""

import base64
import json
import re
from collections.abc import Generator
from contextlib import contextmanager
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.dialects import mysql
from sqlalchemy.engine import ExecutionContext
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.projects import router
from app.core.security import get_current_user
from app.models.project import Project
from app.models.resource_member import ResourceMember
from app.models.task import TaskResource
from app.models.user import User
from app.services import project_service
from tests.retained_python_handlers import component_client


@pytest.fixture
def project(test_db: Session, test_user: User) -> Project:
    project = Project(user_id=test_user.id, name="API", client_origin="frontend")
    test_db.add(project)
    test_db.flush()
    return project


@pytest.fixture
def client(test_db: Session, test_user: User) -> Generator[TestClient, None, None]:
    app = FastAPI()
    app.include_router(router, prefix="/api/projects")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: test_user
    with TestClient(app) as production:
        with component_client(production, ("projects",)) as client:
            yield client


def _task(db: Session, project: Project, **overrides: object) -> TaskResource:
    values = {
        "user_id": project.user_id,
        "kind": "Task",
        "name": f"task-{db.query(TaskResource).count()}",
        "namespace": "default",
        "project_id": project.id,
        "client_origin": project.client_origin,
        "is_active": TaskResource.STATE_ACTIVE,
        "json": {"spec": {"title": "API task"}, "status": {"status": "COMPLETED"}},
    }
    task = TaskResource(**(values | overrides))
    db.add(task)
    db.flush()
    return task


@contextmanager
def _selects(
    db: Session, *, mysql_statements: list[str] | None = None
) -> Generator[list[str], None, None]:
    statements: list[str] = []

    def record(
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        context: ExecutionContext,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)
            if mysql_statements is not None:
                assert context.compiled is not None
                mysql_statements.append(
                    str(
                        context.compiled.statement.compile(
                            dialect=mysql.dialect(),
                            compile_kwargs={"literal_binds": True},
                        )
                    )
                )

    connection = db.connection()
    event.listen(connection, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(connection, "before_cursor_execute", record)


def _large_task_json(index: int) -> dict:
    irrelevant = "x" * (2 * 1024 * 1024 // 3 + 1)
    return {
        "spec": {
            "title": f"Large task {index}",
            "prompt": irrelevant,
            "device_id": f"test-device-{index}",
            "is_group_chat": index % 2 == 1,
            "execution": {
                "workspace": {
                    "path": f" /synthetic/projects/api-{index} ",
                    "source": " device_path ",
                    "extra": {"nested": {"payload": irrelevant}},
                }
            },
        },
        "status": {
            "status": "COMPLETED",
            "result": {"blocks": [{"payload": irrelevant}]},
        },
    }


def _assert_narrow_task_projection(statement: str) -> None:
    projection = statement.split("\nFROM", 1)[0]
    paths = re.findall(r"JSON_EXTRACT\(tasks\.json, '([^']+)'\)", projection)
    assert {path.replace('"', "") for path in paths} == {
        "$.spec.title",
        "$.spec.device_id",
        "$.spec.is_group_chat",
        "$.spec.execution.workspace.source",
        "$.spec.execution.workspace.path",
        "$.status.status",
    }
    assert len(paths) == 6
    assert projection.count("tasks.json") == len(paths)


@pytest.mark.parametrize("title", [None, "Large task"])
def test_large_task_pages_select_only_json_leaves_without_materializing_entities(
    client: TestClient, test_db: Session, project: Project, title: str | None
) -> None:
    timestamp = datetime(2026, 1, 1)
    tasks = [
        _task(
            test_db,
            project,
            created_at=timestamp + timedelta(minutes=index),
            json=_large_task_json(index),
        )
        for index in range(3)
    ]
    assert len(json.dumps(tasks[0].json)) > 2 * 1024 * 1024
    retained = tasks[0]
    original_json = retained.json
    for task in tasks[1:]:
        test_db.expunge(task)
    loaded_tasks: list[TaskResource] = []
    mysql_statements: list[str] = []

    def record_load(_session: Session, entity: object) -> None:
        if isinstance(entity, TaskResource):
            loaded_tasks.append(entity)

    event.listen(test_db, "loaded_as_persistent", record_load)
    try:
        with _selects(test_db, mysql_statements=mysql_statements) as statements:
            params: dict[str, str | int] = {"limit": 2}
            if title is not None:
                params["title"] = title
            first = client.get(f"/api/projects/{project.id}/tasks", params=params)
            assert first.status_code == 200
            second = client.get(
                f"/api/projects/{project.id}/tasks",
                params={**params, "cursor": first.json()["next_cursor"]},
            )
    finally:
        event.remove(test_db, "loaded_as_persistent", record_load)

    assert second.status_code == 200
    assert all(len(response.content) < 4096 for response in (first, second))
    assert first.json()["has_more"] and first.json()["next_cursor"]
    assert not second.json()["has_more"] and second.json()["next_cursor"] is None
    assert first.json()["total"] == second.json()["total"] == 3
    items = first.json()["items"] + second.json()["items"]
    assert [item["task_id"] for item in items] == [task.id for task in reversed(tasks)]
    for index, item in zip(reversed(range(3)), items, strict=True):
        assert item["task_title"] == f"Large task {index}"
        assert item["task_status"] == "COMPLETED"
        assert item["device_id"] == f"test-device-{index}"
        assert item["is_group_chat"] is (index % 2 == 1)
        assert item["execution_workspace_path"] == f"/synthetic/projects/api-{index}"
        assert item["execution_workspace_source"] == "device_path"
    assert len(statements) == len(mysql_statements) == 6
    for statement in (mysql_statements[2], mysql_statements[5]):
        _assert_narrow_task_projection(statement)
    assert loaded_tasks == []
    assert [
        entity
        for entity in test_db.identity_map.values()
        if isinstance(entity, TaskResource)
    ] == [retained]
    assert retained.json is original_json


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"spec": None, "status": None},
        {
            "spec": {
                "title": None,
                "device_id": None,
                "is_group_chat": None,
                "execution": {"workspace": {"path": None, "source": None}},
            },
            "status": {"status": None},
        },
    ],
    ids=["null-document", "missing-fields", "null-containers", "null-leaves"],
)
def test_task_summary_preserves_defaults_for_missing_or_null_json_fields(
    client: TestClient, test_db: Session, project: Project, payload: object
) -> None:
    task = _task(test_db, project, name="fallback-title", json=payload)

    response = client.get(f"/api/projects/{project.id}/tasks")

    assert response.status_code == 200
    result = response.json()
    assert result["total"] == 1
    assert result["items"] == [
        {
            "task_id": task.id,
            "task_title": "fallback-title",
            "task_status": "PENDING",
            "device_id": None,
            "execution_workspace_source": None,
            "execution_workspace_path": None,
            "is_group_chat": False,
            "project_id": project.id,
            "updated_at": task.updated_at.isoformat(),
        }
    ]
    assert not result["has_more"] and result["next_cursor"] is None


@pytest.mark.parametrize("client_origin", ["frontend", "wework"])
def test_existing_project_lists_keep_updated_at_task_order(
    client: TestClient,
    test_db: Session,
    project: Project,
    client_origin: str,
) -> None:
    project.client_origin = client_origin
    timestamp = datetime(2026, 1, 1)
    tasks = [
        _task(
            test_db,
            project,
            created_at=timestamp + timedelta(minutes=index),
            updated_at=timestamp + timedelta(days=3 - index),
        )
        for index in range(3)
    ]
    expected_ids = [task.id for task in tasks]
    params = {"client_origin": client_origin}

    projects_response = client.get("/api/projects", params=params)
    project_response = client.get(f"/api/projects/{project.id}", params=params)

    assert projects_response.status_code == project_response.status_code == 200
    for result in (
        projects_response.json()["items"][0],
        project_response.json(),
    ):
        assert result["task_count"] == 3
        assert [task["task_id"] for task in result["tasks"]] == expected_ids


def test_pages_apply_sql_bounds_and_break_timestamp_ties_by_id(
    client: TestClient, test_db: Session, project: Project
) -> None:
    timestamp = datetime(2026, 1, 1)
    tasks = [
        _task(
            test_db,
            project,
            created_at=timestamp + timedelta(minutes=index // 2),
            updated_at=timestamp + timedelta(days=20 - index),
        )
        for index in range(5)
    ]

    with _selects(test_db) as statements:
        first = client.get(f"/api/projects/{project.id}/tasks?limit=2").json()
    second = client.get(f"/api/projects/{project.id}/tasks?page=2&limit=2").json()
    third = client.get(f"/api/projects/{project.id}/tasks?page=3&limit=2").json()
    empty = client.get(f"/api/projects/{project.id}/tasks?page=4&limit=2").json()

    for response in (first, second, third, empty):
        assert response["total"] == 5
    assert [item["task_id"] for item in first["items"]] == [
        tasks[4].id,
        tasks[3].id,
    ]
    assert [item["task_id"] for item in second["items"]] == [
        tasks[2].id,
        tasks[1].id,
    ]
    assert [item["task_id"] for item in third["items"]] == [tasks[0].id]
    assert empty["items"] == []
    assert first["has_more"] and first["next_cursor"]
    assert second["has_more"] and second["next_cursor"]
    assert not third["has_more"] and third["next_cursor"] is None
    assert not empty["has_more"] and empty["next_cursor"] is None
    assert first["items"][0]["task_title"] == "API task"
    assert first["items"][0]["task_status"] == "COMPLETED"
    assert len(statements) == 3
    task_select = statements[-1].upper()
    assert "LIMIT" in task_select and "OFFSET" in task_select
    assert "ORDER BY TASKS.CREATED_AT DESC, TASKS.ID DESC" in task_select


@pytest.mark.parametrize("mutation", ["update", "insert", "delete_anchor"])
def test_cursor_pages_remain_stable_when_tasks_change(
    client: TestClient, test_db: Session, project: Project, mutation: str
) -> None:
    timestamp = datetime(2026, 1, 1)
    tasks = [
        _task(test_db, project, created_at=timestamp + timedelta(minutes=index // 2))
        for index in range(6)
    ]
    expected_ids = [task.id for task in reversed(tasks)]
    first = client.get(f"/api/projects/{project.id}/tasks?limit=2").json()

    if mutation == "update":
        tasks[0].updated_at = timestamp + timedelta(days=30)
        expected_total = 6
    elif mutation == "insert":
        _task(test_db, project, created_at=timestamp + timedelta(days=1))
        expected_total = 7
    else:
        test_db.delete(tasks[4])
        expected_total = 5
    test_db.flush()

    collected_ids = [item["task_id"] for item in first["items"]]
    cursor = first["next_cursor"]
    for _ in range(2):
        with _selects(test_db) as statements:
            response = client.get(
                f"/api/projects/{project.id}/tasks",
                params={"limit": 2, "page": 99, "cursor": cursor},
            )
        assert response.status_code == 200
        result = response.json()
        assert result["total"] == expected_total
        assert len(statements) == 3
        assert "tasks.created_at <" in statements[-1]
        collected_ids.extend(item["task_id"] for item in result["items"])
        cursor = result["next_cursor"]
        assert result["has_more"] == (cursor is not None)

    assert collected_ids == expected_ids
    assert cursor is None


@pytest.mark.parametrize("count", [0, 2])
def test_empty_or_exactly_full_last_page_has_no_next_cursor(
    client: TestClient, test_db: Session, project: Project, count: int
) -> None:
    for _ in range(count):
        _task(test_db, project)

    response = client.get(f"/api/projects/{project.id}/tasks?limit=2").json()

    assert len(response["items"]) == response["total"] == count
    assert not response["has_more"]
    assert response["next_cursor"] is None


@pytest.mark.parametrize("page", [3, 2**128])
def test_out_of_range_page_does_not_query_task_rows(
    client: TestClient, test_db: Session, project: Project, page: int
) -> None:
    for _ in range(3):
        _task(test_db, project)
    url = f"/api/projects/{project.id}/tasks"

    with _selects(test_db) as statements:
        response = client.get(url, params={"page": page, "limit": 2})

    assert response.status_code == 200
    assert response.json() == {
        "total": 3,
        "items": [],
        "has_more": False,
        "next_cursor": None,
    }
    assert len(statements) == 2


def test_cursor_takes_precedence_over_out_of_range_page(
    client: TestClient, test_db: Session, project: Project
) -> None:
    timestamp = datetime(2026, 1, 1)
    tasks = [
        _task(test_db, project, created_at=timestamp + timedelta(minutes=index))
        for index in range(3)
    ]
    url = f"/api/projects/{project.id}/tasks"
    first = client.get(url, params={"limit": 1}).json()

    with _selects(test_db) as statements:
        response = client.get(
            url, params={"limit": 1, "page": 2**128, "cursor": first["next_cursor"]}
        )

    assert response.status_code == 200
    result = response.json()
    assert result["total"] == 3
    assert [item["task_id"] for item in result["items"]] == [tasks[1].id]
    assert result["has_more"] and result["next_cursor"]
    assert len(statements) == 3


def _cursor(payload: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    "cursor",
    [
        "",
        "not-a-cursor",
        "%%%%",
        _cursor([]),
        _cursor({}),
        _cursor({"created_at": "invalid", "id": 1}),
        _cursor({"created_at": "2026-01-01", "id": 1}),
        _cursor({"created_at": "2026-01-01T00:00:00+00:00", "id": 1}),
        _cursor({"created_at": "0001-01-01T00:00:00", "id": 1}),
        _cursor({"created_at": "2026-01-01T00:00:00", "id": 0}),
        _cursor({"created_at": "2026-01-01T00:00:00", "id": -1}),
        _cursor({"created_at": "2026-01-01T00:00:00", "id": True}),
        _cursor({"created_at": "2026-01-01T00:00:00", "id": "1"}),
        _cursor({"created_at": "2026-01-01T00:00:00", "id": 2**63}),
    ],
)
def test_invalid_cursor_is_rejected_without_querying_database(
    client: TestClient, test_db: Session, project: Project, cursor: str
) -> None:
    url = f"/api/projects/{project.id}/tasks"

    with _selects(test_db) as statements:
        response = client.get(url, params={"cursor": cursor})

    assert response.status_code == 400
    assert statements == []


def test_task_page_and_metadata_count_exclude_other_states_kinds_owners_and_clients(
    client: TestClient, test_db: Session, project: Project
) -> None:
    active = _task(test_db, project)
    for state in (
        TaskResource.STATE_DELETED,
        TaskResource.STATE_ARCHIVED,
        TaskResource.STATE_SUBSCRIPTION,
    ):
        _task(test_db, project, is_active=state)
    _task(test_db, project, kind="Workspace")
    _task(test_db, project, user_id=project.user_id + 1000)
    _task(test_db, project, client_origin="wework")
    _task(test_db, project, project_id=project.id + 1000)
    _task(test_db, project, json={"status": {"status": "DELETE"}})

    response = client.get(f"/api/projects/{project.id}/tasks")
    metadata = project_service.list_projects(
        test_db, project.user_id, include_tasks=False, client_origin="frontend"
    )

    assert response.status_code == 200
    assert response.json()["total"] == metadata.items[0].task_count == 1
    assert [item["task_id"] for item in response.json()["items"]] == [active.id]
    assert metadata.items[0].tasks == []


@pytest.mark.parametrize("title", [None, "API"])
@pytest.mark.parametrize("member_status", [None, "pending", "rejected", "approved"])
def test_shared_project_reader_must_have_approved_membership(
    client: TestClient,
    test_db: Session,
    project: Project,
    member_status: str | None,
    title: str | None,
) -> None:
    owner_task = _task(test_db, project)
    viewer = User(user_name="project-viewer", password_hash="unused")
    test_db.add(viewer)
    test_db.flush()
    _task(test_db, project, user_id=viewer.id)
    if member_status:
        test_db.add(
            ResourceMember.create(
                resource_type="Project",
                resource_id=project.id,
                entity_id=str(viewer.id),
                role="Viewer",
                status=member_status,
            )
        )
        test_db.flush()
    client.app.dependency_overrides[get_current_user] = lambda: viewer

    response = client.get(
        f"/api/projects/{project.id}/tasks",
        params={"title": title} if title is not None else {},
    )

    if member_status == "approved":
        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert [item["task_id"] for item in response.json()["items"]] == [owner_task.id]
    else:
        assert response.status_code == 404


def test_projects_are_scoped_to_requested_client_and_active_state(
    client: TestClient, test_db: Session, project: Project
) -> None:
    project.client_origin = "wework"
    task = _task(test_db, project)

    assert client.get(f"/api/projects/{project.id}/tasks").status_code == 404
    response = client.get(f"/api/projects/{project.id}/tasks?client_origin=wework")
    assert response.status_code == 200
    assert response.json()["items"][0]["task_id"] == task.id
    project.is_active = False
    test_db.flush()
    assert (
        client.get(f"/api/projects/{project.id}/tasks?client_origin=wework").status_code
        == 404
    )


@pytest.mark.parametrize(
    "query",
    [
        "page=0",
        "limit=0",
        "limit=101",
        "client_origin=bad",
        f"cursor={'x' * 513}",
        "title=",
    ],
)
def test_pagination_parameters_are_bounded(
    client: TestClient, project: Project, query: str
) -> None:
    assert client.get(f"/api/projects/{project.id}/tasks?{query}").status_code == 422


def test_metadata_counts_use_one_grouped_query_without_loading_task_json(
    test_db: Session, test_user: User, project: Project
) -> None:
    _task(test_db, project)
    _task(test_db, project)
    for index in range(6):
        group = Project(user_id=test_user.id, name=f"Group {index}")
        test_db.add(group)
        test_db.flush()
        _task(test_db, group)
    empty = Project(user_id=test_user.id, name="Empty")
    test_db.add(empty)
    test_db.flush()
    user_id = test_user.id

    with _selects(test_db) as statements:
        response = project_service.list_projects(
            test_db, user_id, include_tasks=False, client_origin="frontend"
        )

    assert len(statements) == 2
    assert "GROUP BY tasks.project_id" in statements[1]
    assert "tasks.json" not in statements[1].split("FROM", 1)[0]
    groups = {item.id: item for item in response.items}
    assert groups[project.id].task_count == 2
    assert groups[empty.id].task_count == 0
    assert all(group.tasks == [] for group in response.items)


def test_project_title_search_filters_before_count_and_cursor_pagination(
    client: TestClient, test_db: Session, project: Project
) -> None:
    timestamp = datetime(2026, 1, 1)
    matching = [
        _task(
            test_db,
            project,
            created_at=timestamp + timedelta(seconds=index),
            json={"spec": {"title": f"Pagination target {index}"}},
        )
        for index in range(5)
    ]
    for index in range(120):
        _task(
            test_db,
            project,
            created_at=timestamp + timedelta(minutes=index + 1),
            json={"spec": {"title": f"Other conversation {index}"}},
        )

    params: dict[str, str | int] = {"title": "pagination", "limit": 2}
    found: list[int] = []
    for expected_count in (2, 2, 1):
        response = client.get(f"/api/projects/{project.id}/tasks", params=params)
        assert response.status_code == 200
        page = response.json()
        assert page["total"] == 5
        assert len(page["items"]) == expected_count
        found.extend(item["task_id"] for item in page["items"])
        if expected_count == 2:
            assert page["has_more"] and page["next_cursor"]
            params["cursor"] = page["next_cursor"]
        else:
            assert not page["has_more"] and page["next_cursor"] is None

    assert found == [task.id for task in reversed(matching)]
    offset_page = client.get(
        f"/api/projects/{project.id}/tasks",
        params={"title": "pagination", "limit": 2, "page": 2},
    )
    assert offset_page.status_code == 200
    assert offset_page.json()["total"] == 5
    assert [item["task_id"] for item in offset_page.json()["items"]] == found[2:4]


def test_project_title_search_keeps_project_owner_client_and_state_filters(
    client: TestClient, test_db: Session, project: Project
) -> None:
    matching = _task(test_db, project)
    other_project = Project(user_id=project.user_id, name="Other group")
    test_db.add(other_project)
    test_db.flush()
    _task(test_db, other_project)
    _task(test_db, project, project_id=0)
    _task(test_db, project, user_id=project.user_id + 1)
    _task(test_db, project, client_origin="wework")
    _task(test_db, project, is_active=TaskResource.STATE_ARCHIVED)
    _task(test_db, project, is_active=TaskResource.STATE_DELETED)
    _task(
        test_db,
        project,
        json={"spec": {"title": "API task"}, "status": {"status": "DELETE"}},
    )

    response = client.get(
        f"/api/projects/{project.id}/tasks", params={"title": "api", "limit": 1}
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [item["task_id"] for item in response.json()["items"]] == [matching.id]
    assert not response.json()["has_more"]
    assert response.json()["next_cursor"] is None


@pytest.mark.parametrize("keyword", ["%", "_", "/", "PAGINATION", "分页"])
def test_project_title_search_matches_literal_case_insensitive_keywords(
    client: TestClient, test_db: Session, project: Project, keyword: str
) -> None:
    matching = _task(
        test_db, project, json={"spec": {"title": f"Test {keyword.lower()} title"}}
    )
    _task(test_db, project, json={"spec": {"title": "Other conversation"}})

    response = client.get(
        f"/api/projects/{project.id}/tasks", params={"title": keyword}
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [item["task_id"] for item in response.json()["items"]] == [matching.id]


@pytest.mark.parametrize("stored_title", [None, ""])
def test_project_title_search_uses_display_name_when_title_is_empty(
    client: TestClient, test_db: Session, project: Project, stored_title: str | None
) -> None:
    matching = _task(
        test_db,
        project,
        name="Fallback needle",
        json={"spec": {"title": stored_title}},
    )
    _task(test_db, project)

    response = client.get(
        f"/api/projects/{project.id}/tasks", params={"title": "needle"}
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["items"][0]["task_id"] == matching.id
    assert response.json()["items"][0]["task_title"] == "Fallback needle"
