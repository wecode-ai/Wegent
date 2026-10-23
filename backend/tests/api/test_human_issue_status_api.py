# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Human-assigned Issues use ordinary status edits and optional task bindings."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.delivery import (
    CloudProject,
    LoopItemTaskBinding,
    WorkspaceCleanupIntent,
)
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.services.collaboration_human_assignments import (
    collaboration_human_assignment_status,
)
from app.services.issue_assignments import issue_assignment_service
from tests.service_results import service_result
from tests.utils.collaboration import authorize_project


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _member(
    db: Session, project: CloudProject, *, role: str = "Developer"
) -> tuple[User, str]:
    name = f"human-work-{uuid4().hex[:8]}"
    user = User(
        user_name=name,
        password_hash=get_password_hash("human-work-password"),
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.flush()
    member = ResourceMember.create(
        resource_type=ResourceType.CLOUD_PROJECT.value,
        resource_id=project.id,
        entity_id=str(user.id),
        role=role,
        status=MemberStatus.APPROVED.value,
    )
    db.add(member)
    db.commit()
    return user, create_access_token(data={"sub": name})


@pytest.fixture
def project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"HUMAN{uuid4().hex[:5].upper()}",
        name="Human work",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _assigned_issue(
    client: TestClient, project: CloudProject, owner_token: str, assignee: User
) -> dict:
    created = client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items",
        headers=_auth(owner_token),
        json={"title": "Human assigned Issue", "status": "pending"},
    )
    assert created.status_code == 201
    assigned = client.post(
        f"/api/v1/loop-items/{created.json()['id']}/assignments",
        headers=_auth(owner_token),
        json={"target_type": "human", "target_id": str(assignee.id)},
    )
    assert assigned.status_code == 201, assigned.text
    return assigned.json()["issue"]


def test_implicit_creator_assignment_keeps_board_status_editable(
    test_client: TestClient,
    test_token: str,
    project: CloudProject,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Implicit creator assignment"},
    )
    assert created.status_code == 201
    issue = created.json()
    assert issue["assignee_user_id"] == project.created_by_user_id
    assert "human_work" not in issue

    updated = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(test_token),
        json={
            "version": issue["version"],
            "status": "in_progress",
            "assignee_user_id": project.created_by_user_id,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "in_progress"


@pytest.mark.parametrize("initial_status", ["pending", "in_progress", "in_review"])
def test_editor_can_complete_and_reopen_human_issue_without_extra_information(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
    initial_status: str,
) -> None:
    assignee, _ = _member(test_db, project)
    _, editor_token = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    url = f"/api/v1/loop-items/{issue['id']}"

    if initial_status != issue["status"]:
        started = test_client.patch(
            url,
            headers=_auth(editor_token),
            json={"version": issue["version"], "status": initial_status},
        )
        assert started.status_code == 200, started.text
        issue = started.json()

    completed = test_client.patch(
        url,
        headers=_auth(editor_token),
        json={
            "version": issue["version"],
            "status": "completed",
        },
    )
    assert completed.status_code == 200, completed.text
    issue = completed.json()
    assert issue["status"] == "completed"
    assert issue["completed_at"] is not None
    assert issue["assignee_user_id"] == assignee.id
    assert "human_work" not in issue

    reopened = test_client.patch(
        url,
        headers=_auth(editor_token),
        json={"version": issue["version"], "status": "in_progress"},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["completed_at"] is None
    assert "human_work" not in reopened.json()
    messages_before = test_db.query(ProjectChatMessage).count()
    stale = test_client.patch(
        url,
        headers=_auth(editor_token),
        json={
            "version": issue["version"],
            "status": "completed",
        },
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "version_conflict"
    assert test_db.query(ProjectChatMessage).count() == messages_before


@pytest.mark.parametrize("target_status", ["in_progress", "in_review", "completed"])
def test_viewer_cannot_change_human_issue_status(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
    target_status: str,
) -> None:
    assignee, _ = _member(test_db, project)
    _, viewer_token = _member(test_db, project, role="Viewer")
    issue = _assigned_issue(test_client, project, test_token, assignee)
    response = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(viewer_token),
        json={
            "version": issue["version"],
            "status": target_status,
        },
    )
    assert response.status_code == 403, response.text
    current = test_client.get(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(test_token),
    ).json()
    assert current["version"] == issue["version"]
    assert current["status"] == issue["status"]


def test_stale_unassignment_preserves_the_active_assignment(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
) -> None:
    assignee, _ = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    assignment_id = issue_assignment_service.active_for_issue(test_db, issue["id"])[
        0
    ].id

    response = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(test_token),
        json={"version": issue["version"] - 1, "assignee_user_id": None},
    )

    assert response.status_code == 409, response.text
    active = issue_assignment_service.active_for_issue(test_db, issue["id"])
    assert [assignment.id for assignment in active] == [assignment_id]
    current = test_client.get(
        f"/api/v1/loop-items/{issue['id']}", headers=_auth(test_token)
    ).json()
    assert current["assignee_user_id"] == assignee.id
    assert current["version"] == issue["version"]


def test_unassignment_preserves_workflow_assignments(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
) -> None:
    assignee, _ = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    workflow_assignment, _ = issue_assignment_service.record(
        test_db,
        project_id=project.id,
        issue_id=issue["id"],
        member_type="human",
        member_id=str(assignee.id),
        assigned_by_user_id=project.created_by_user_id,
        workflow_step="review",
        notify=False,
        trigger="manual",
    )
    test_db.commit()

    response = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(test_token),
        json={"version": issue["version"], "assignee_user_id": None},
    )

    assert response.status_code == 200, response.text
    active = issue_assignment_service.active_for_issue(test_db, issue["id"])
    assert [assignment.id for assignment in active] == [workflow_assignment.id]


@pytest.mark.parametrize("status", ["inbox", "pending", "in_review", "completed"])
def test_task_binding_is_persisted_before_status_transition(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
    status: str,
) -> None:
    assignee, token = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    url = f"/api/v1/loop-items/{issue['id']}"
    if status != issue["status"]:
        updated = test_client.patch(
            url,
            headers=_auth(test_token),
            json={"version": issue["version"], "status": status},
        )
        assert updated.status_code == 200, updated.text
    response = test_client.get(url, headers=_auth(token))
    assert response.status_code == 200, response.text
    issue = response.json()
    identity = issue["human_task_binding"]
    assignment = issue_assignment_service.active_for_issue(test_db, issue["id"])[0]
    assert identity["assignmentId"] == assignment.id
    assert identity["humanAssignmentId"]
    assert identity["dispatchId"] == f"direct-human:{assignment.id}"
    assert identity["dispatchRoundId"] == "direct"
    assert (
        test_client.get(url, headers=_auth(test_token)).json()["human_task_binding"]
        is None
    )

    saved = test_client.post(
        f"{url}/tasks",
        headers=_auth(token),
        json={"deviceId": "assigned-device", "taskId": "assigned-task", **identity},
    )
    assert saved.status_code == 201, saved.text
    for field, alias in (
        ("human_assignment_id", "humanAssignmentId"),
        ("dispatch_id", "dispatchId"),
        ("dispatch_round_id", "dispatchRoundId"),
        ("assignment_id", "assignmentId"),
    ):
        assert saved.json()[field] == identity[alias]
    current = test_client.get(url, headers=_auth(token)).json()
    assert current["status"] == status
    assert current["version"] == issue["version"]
    projection = service_result(
        lambda: {
            "items": [
                collaboration_human_assignment_status(
                    test_db,
                    project_id=int(project.id),
                    issue_id=issue["id"],
                    human_assignment_id=identity,
                )
                for identity in [identity["humanAssignmentId"]]
            ]
        }
    )
    assert projection.status_code == 200, projection.text
    assert projection.json()["items"][0]["status"] == "running"
    assert projection.json()["items"][0]["runtime_task_id"] == "assigned-task"


def test_assigned_task_binding_survives_normal_status_changes(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
) -> None:
    assignee, assignee_token = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    url = f"/api/v1/loop-items/{issue['id']}"
    assert issue["human_task_binding"] is None
    started = test_client.patch(
        url,
        headers=_auth(assignee_token),
        json={"version": issue["version"], "status": "in_progress"},
    )
    assert started.status_code == 200, started.text
    issue = started.json()
    binding = issue["human_task_binding"]
    assignment = issue_assignment_service.active_for_issue(test_db, issue["id"])[0]
    assert binding["assignmentId"] == assignment.id
    assert binding["dispatchRoundId"] == "direct"
    assert binding["humanAssignmentId"]
    assert (
        test_client.get(url, headers=_auth(test_token)).json()["human_task_binding"]
        is None
    )
    test_db.add(
        LoopItemTaskBinding(
            cloud_project_id=project.id,
            loop_item_id=issue["id"],
            task_user_id=assignee.id,
            device_id="assigned-device",
            task_id="assigned-task",
            task_title=issue["title"],
            linked_by_user_id=assignee.id,
        )
    )
    test_db.commit()
    completed = test_client.patch(
        url,
        headers=_auth(test_token),
        json={"version": issue["version"], "status": "completed"},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["assignee_user_id"] == assignee.id
    cleanup = (
        test_db.query(WorkspaceCleanupIntent).filter_by(loop_item_id=issue["id"]).one()
    )
    assert cleanup.status == "pending"
    assert cleanup.metadata_json["runtime_task_ids"] == ["assigned-task"]
    reopened = test_client.patch(
        url,
        headers=_auth(assignee_token),
        json={"version": completed.json()["version"], "status": "in_progress"},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["human_task_binding"] == binding
