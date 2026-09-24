"""Project visibility must agree with navigation without per-project queries."""

import uuid
from collections.abc import Generator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.cloud_project import CloudProject
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.cloud_project import CloudProjectCreate
from app.schemas.workspace import WorkspaceCreate
from app.services.cloud_projects import cloud_project_service
from app.services.cloud_projects.responses import list_project_responses
from app.services.workspaces import workspace_service
from app.services.workspaces.storage import CollaborationWorkspace


@pytest.fixture
def viewer(test_db: Session) -> User:
    name = f"navigation-{uuid.uuid4().hex[:8]}"
    user = User(
        user_name=name,
        email=f"{name}@example.com",
        password_hash="unused",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _headers(user: User) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(data={'sub': user.user_name})}"
    }


def _project(
    db: Session, owner: User, workspace: CollaborationWorkspace, *, public: bool = False
) -> CloudProject:
    return cloud_project_service.create(
        db,
        owner.id,
        CloudProjectCreate(
            name=f"Project {uuid.uuid4().hex[:8]}",
            workspace_id=str(workspace.id),
            visibility="public" if public else "private",
        ),
    )


def _member(
    db: Session,
    user: User,
    resource_type: str,
    resource_id: int | str,
    *,
    role: str | None = None,
    status: str = "approved",
) -> ResourceMember:
    member = ResourceMember.create(
        resource_type=resource_type,
        resource_id=int(resource_id),
        entity_id=str(user.id),
        role=role or ("Reporter" if resource_type == "Workspace" else "Viewer"),
        status=status,
    )
    db.add(member)
    db.commit()
    return member


@pytest.mark.parametrize("source", ["public", "project", "workspace"])
def test_visible_projects_include_parent_without_expanding_workspace_permissions(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    viewer: User,
    source: str,
) -> None:
    workspace = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Parent")
    )
    project = _project(test_db, test_user, workspace, public=source == "public")
    sibling = _project(test_db, test_user, workspace)
    if source != "public":
        _member(
            test_db,
            viewer,
            "Workspace" if source == "workspace" else "CloudProject",
            workspace.id if source == "workspace" else project.id,
        )
    headers = _headers(viewer)
    expected = {str(project.id)}
    if source == "workspace":
        expected.add(str(sibling.id))

    for endpoint in (
        "/api/v1/cloud-projects",
        f"/api/v1/cloud-projects?workspace_id={workspace.id}",
        f"/api/v1/workspaces/{workspace.id}/projects",
    ):
        response = test_client.get(endpoint, headers=headers)
        assert response.status_code == 200, response.text
        items = response.json()["items"]
        assert {item["id"] for item in items} == expected
        assert len(items) == len(expected)
        for item in items:
            assert item["workspace_context"] == {
                "id": str(workspace.id),
                "public_id": workspace.public_id,
                "name": workspace.name,
            }
            assert item["access_role"] == "Viewer"

    detail = test_client.get(f"/api/v1/cloud-projects/{project.id}", headers=headers)
    assert detail.status_code == 200, detail.text
    sibling_detail = test_client.get(
        f"/api/v1/cloud-projects/{sibling.id}", headers=headers
    )
    assert sibling_detail.status_code == (200 if source == "workspace" else 404)
    members = test_client.get(
        f"/api/v1/workspaces/{workspace.id}/members", headers=headers
    )
    assert members.status_code == (200 if source == "workspace" else 404)
    # Inherited visibility must not confer project administration.
    update = test_client.patch(
        f"/api/v1/cloud-projects/{project.id}",
        headers=headers,
        json={"version": project.version, "name": "Unauthorized rename"},
    )
    assert update.status_code == 403


@pytest.mark.parametrize(
    "status,role",
    [
        ("pending", "Reporter"),
        ("rejected", "Reporter"),
        ("approved", "invalid"),
        ("approved", "RestrictedAnalyst"),
    ],
)
def test_invalid_space_membership_does_not_reveal_projects(
    test_db: Session,
    test_user: User,
    viewer: User,
    status: str,
    role: str,
) -> None:
    workspace = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Private")
    )
    _project(test_db, test_user, workspace)
    _member(test_db, viewer, "Workspace", workspace.id, role=role, status=status)
    assert list_project_responses(test_db, viewer) == []


def test_overlapping_grants_deduplicate_and_preserve_project_role(
    test_db: Session,
    test_user: User,
    viewer: User,
) -> None:
    workspace = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Overlap")
    )
    project = _project(test_db, test_user, workspace, public=True)
    _member(test_db, viewer, "Workspace", workspace.id, role="Owner")
    explicit = _member(test_db, viewer, "CloudProject", project.id, role="Maintainer")
    items = list_project_responses(test_db, viewer)
    assert len(items) == 1
    assert items[0].access_role.value == "Maintainer"
    test_db.delete(explicit)
    test_db.commit()
    assert list_project_responses(test_db, viewer)[0].access_role.value == "Viewer"
    kind = test_db.get(Kind, workspace.id)
    kind.is_active = False
    public_grant = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "CloudProject",
            ResourceMember.resource_id == project.id,
            ResourceMember.entity_type == "authenticated_users",
        )
        .one()
    )
    test_db.delete(public_grant)
    test_db.commit()
    assert list_project_responses(test_db, viewer) == []


@contextmanager
def _selects(db: Session) -> Generator[list[str], None, None]:
    statements: list[str] = []

    def record(
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


def test_project_list_uses_three_queries_as_project_count_grows(
    test_db: Session,
    test_user: User,
    viewer: User,
) -> None:
    workspace = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Queries")
    )
    _member(test_db, viewer, "Workspace", workspace.id)
    for size in range(1, 7):
        _project(test_db, test_user, workspace)
        test_db.refresh(viewer)
        with _selects(test_db) as statements:
            items = list_project_responses(test_db, viewer)
        assert len(items) == size
        assert len(statements) == 3


def test_workspace_list_batches_counts_and_keeps_empty_spaces(
    test_db: Session,
    test_user: User,
) -> None:
    from app.services.workspaces.responses import list_workspace_responses

    empty = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Empty")
    )
    populated = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Populated")
    )
    _project(test_db, test_user, populated)
    _project(test_db, test_user, populated)
    user_id = test_user.id
    with _selects(test_db) as statements:
        items = list_workspace_responses(test_db, user_id)
    assert len(statements) == 3
    by_id = {int(item.id): item for item in items}
    assert by_id[empty.id].project_count == 0
    assert by_id[populated.id].project_count == 2
    assert by_id[empty.id].member_count == by_id[populated.id].member_count == 1
    assert by_id[empty.id].access_role.value == "Owner"


def test_removing_membership_and_archiving_project_take_effect_immediately(
    test_db: Session,
    test_user: User,
    viewer: User,
) -> None:
    workspace = workspace_service.create(
        test_db, test_user.id, WorkspaceCreate(name="Revocation")
    )
    private = _project(test_db, test_user, workspace)
    public = _project(test_db, test_user, workspace, public=True)
    membership = _member(test_db, viewer, "Workspace", workspace.id)
    assert len(list_project_responses(test_db, viewer)) == 2
    test_db.delete(membership)
    test_db.commit()
    assert [item.id for item in list_project_responses(test_db, viewer)] == [
        str(public.id)
    ]
    explicit = _member(test_db, viewer, "CloudProject", private.id)
    public.status = "archived"
    test_db.commit()
    assert [item.id for item in list_project_responses(test_db, viewer)] == [
        str(private.id)
    ]
    test_db.delete(explicit)
    test_db.commit()
    assert list_project_responses(test_db, viewer) == []
