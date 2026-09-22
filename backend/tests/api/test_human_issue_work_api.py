# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The assignee and assigner share a versioned human Issue review contract."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    WorkspaceCleanupIntent,
)
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.services.issue_assignments import issue_assignment_service


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _member(
    db: Session, project: CloudProject, *, role: str = "Reporter"
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
        status=MemberStatus.APPROVED.value,
    )
    member.role = role
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
    assert issue["human_work"] is None

    updated = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(test_token),
        json={"version": issue["version"], "status": "in_progress"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "in_progress"


def test_explicit_self_assignment_activates_human_work_after_default(
    test_client: TestClient,
    test_token: str,
    project: CloudProject,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Assign myself explicitly"},
    ).json()
    assert created["human_work"] is None

    assigned = test_client.post(
        f"/api/v1/loop-items/{created['id']}/assignments",
        headers=_auth(test_token),
        json={
            "target_type": "human",
            "target_id": str(project.created_by_user_id),
        },
    )
    assert assigned.status_code == 201, assigned.text
    issue = assigned.json()["issue"]
    assert issue["human_work"]["can_start"] is True


def test_assignee_submits_and_assigner_accepts(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.socketio.get_sio", lambda: SimpleNamespace(emit=AsyncMock())
    )
    assignee, assignee_token = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    item_id = issue["id"]
    stored = test_db.get(LoopItem, item_id)
    active = issue_assignment_service.active_for_issue(test_db, item_id)
    assert issue["human_work"] is not None, {
        "assignee": issue["assignee_user_id"],
        "workflow": issue["workflow"],
        "provider": project.task_provider,
        "active": [
            (event.member_type, event.member_id, event.workflow_step)
            for event in active
        ],
        "stored_assignee": stored.assignee_user_id if stored else None,
    }
    assert issue["human_work"]["can_start"] is False

    test_db.add(
        LoopItemTaskBinding(
            cloud_project_id=project.id,
            loop_item_id=item_id,
            task_user_id=assignee.id,
            device_id="human-work-device",
            task_id="human-work-runtime-task",
            task_title=stored.title,
            linked_by_user_id=assignee.id,
        )
    )
    test_db.commit()

    assignee_view = test_client.get(
        f"/api/v1/loop-items/{item_id}", headers=_auth(assignee_token)
    ).json()
    assert assignee_view["human_work"]["can_start"] is True
    assert assignee_view["human_work"]["reviewer_user_id"] == test_user.id

    bypass = test_client.patch(
        f"/api/v1/loop-items/{item_id}",
        headers=_auth(test_token),
        json={"version": issue["version"], "status": "completed"},
    )
    assert bypass.status_code == 409

    started = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/start",
        headers=_auth(assignee_token),
        json={"version": assignee_view["version"]},
    )
    assert started.status_code == 200, started.text
    assert started.json()["issue"]["status"] == "in_progress"

    submission = {
        "version": started.json()["issue"]["version"],
        "request_id": str(uuid4()),
        "summary": "Fixed the problem and linked the evidence.",
    }
    submitted = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/submit",
        headers=_auth(assignee_token),
        json=submission,
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["issue"]["status"] == "in_review"
    assert submitted.json()["message"]["metadata"]["human_work_action"] == "submitted"
    duplicate = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/submit",
        headers=_auth(assignee_token),
        json=submission,
    )
    assert duplicate.status_code == 200, duplicate.text
    assert (
        duplicate.json()["message"]["messageId"]
        == submitted.json()["message"]["messageId"]
    )
    assert duplicate.json()["issue"]["version"] == submitted.json()["issue"]["version"]

    review_queue = test_client.get(
        "/api/v1/cloud-work-items/my-work", headers=_auth(test_token)
    )
    assert review_queue.status_code == 200, review_queue.text
    review_item = next(
        item for item in review_queue.json()["items"] if item["id"] == item_id
    )
    assert review_item["human_work"]["can_review"] is True

    accepted = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/review",
        headers=_auth(test_token),
        json={
            "version": submitted.json()["issue"]["version"],
            "request_id": str(uuid4()),
            "decision": "accept",
        },
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["issue"]["status"] == "completed"
    cleanup_intent = (
        test_db.query(WorkspaceCleanupIntent)
        .filter(WorkspaceCleanupIntent.loop_item_id == item_id)
        .one()
    )
    assert cleanup_intent.status == "pending"
    assert cleanup_intent.version == accepted.json()["issue"]["version"]
    assert cleanup_intent.metadata_json["runtime_task_ids"] == [
        "human-work-runtime-task"
    ]


def test_reviewer_can_request_changes_but_assignee_cannot_review(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.socketio.get_sio", lambda: SimpleNamespace(emit=AsyncMock())
    )
    assignee, assignee_token = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, assignee)
    item_id = issue["id"]
    started = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/start",
        headers=_auth(assignee_token),
        json={"version": issue["version"]},
    ).json()["issue"]
    submitted = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/submit",
        headers=_auth(assignee_token),
        json={
            "version": started["version"],
            "request_id": str(uuid4()),
            "summary": "Done",
        },
    ).json()["issue"]

    denied = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/review",
        headers=_auth(assignee_token),
        json={
            "version": submitted["version"],
            "request_id": str(uuid4()),
            "decision": "accept",
        },
    )
    assert denied.status_code == 403
    missing_reason = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/review",
        headers=_auth(test_token),
        json={
            "version": submitted["version"],
            "request_id": str(uuid4()),
            "decision": "request_changes",
        },
    )
    assert missing_reason.status_code == 422
    returned = test_client.post(
        f"/api/v1/loop-items/{item_id}/work/review",
        headers=_auth(test_token),
        json={
            "version": submitted["version"],
            "request_id": str(uuid4()),
            "decision": "request_changes",
            "reason": "Add a regression test",
        },
    )
    assert returned.status_code == 200, returned.text
    assert returned.json()["issue"]["status"] == "in_progress"
    assert returned.json()["issue"]["human_work"]["can_review"] is False


def test_non_creator_assigner_appears_in_review_queue(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.socketio.get_sio", lambda: SimpleNamespace(emit=AsyncMock())
    )
    maintainer, maintainer_token = _member(test_db, project, role="Maintainer")
    assignee, assignee_token = _member(test_db, project)
    created = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Review queue", "status": "pending"},
    ).json()
    assigned = test_client.post(
        f"/api/v1/loop-items/{created['id']}/assignments",
        headers=_auth(maintainer_token),
        json={"target_type": "human", "target_id": str(assignee.id)},
    )
    assert assigned.status_code == 201, assigned.text
    assert assigned.json()["issue"]["human_work"]["reviewer_user_id"] == maintainer.id
    started = test_client.post(
        f"/api/v1/loop-items/{created['id']}/work/start",
        headers=_auth(assignee_token),
        json={"version": assigned.json()["issue"]["version"]},
    ).json()["issue"]
    submitted = test_client.post(
        f"/api/v1/loop-items/{created['id']}/work/submit",
        headers=_auth(assignee_token),
        json={
            "version": started["version"],
            "request_id": str(uuid4()),
            "summary": "Ready for the original assigner",
        },
    )
    assert submitted.status_code == 200, submitted.text

    my_work = test_client.get(
        "/api/v1/cloud-work-items/my-work", headers=_auth(maintainer_token)
    )
    assert my_work.status_code == 200, my_work.text
    review_item = next(
        row for row in my_work.json()["items"] if row["id"] == created["id"]
    )
    assert review_item["human_work"]["can_review"] is True


def test_self_assignment_uses_maintainer_fallback(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.socketio.get_sio", lambda: SimpleNamespace(emit=AsyncMock())
    )
    _maintainer, maintainer_token = _member(test_db, project, role="Maintainer")
    _reporter, reporter_token = _member(test_db, project)
    created = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Self assigned",
            "status": "pending",
            "assignee_user_id": test_user.id,
        },
    ).json()
    assert created["human_work"]["reviewer_user_id"] is None
    started = test_client.post(
        f"/api/v1/loop-items/{created['id']}/work/start",
        headers=_auth(test_token),
        json={"version": created["version"]},
    ).json()["issue"]
    submitted = test_client.post(
        f"/api/v1/loop-items/{created['id']}/work/submit",
        headers=_auth(test_token),
        json={
            "version": started["version"],
            "request_id": str(uuid4()),
            "summary": "Done",
        },
    )
    assert submitted.status_code == 200, submitted.text
    maintainer_view = test_client.get(
        f"/api/v1/loop-items/{created['id']}", headers=_auth(maintainer_token)
    ).json()
    reporter_view = test_client.get(
        f"/api/v1/loop-items/{created['id']}", headers=_auth(reporter_token)
    ).json()
    assert maintainer_view["human_work"]["can_review"] is True
    assert reporter_view["human_work"]["can_review"] is False


def test_reassignment_resets_pending_review(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.socketio.get_sio", lambda: SimpleNamespace(emit=AsyncMock())
    )
    first, first_token = _member(test_db, project)
    second, second_token = _member(test_db, project)
    issue = _assigned_issue(test_client, project, test_token, first)
    started = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/work/start",
        headers=_auth(first_token),
        json={"version": issue["version"]},
    ).json()["issue"]
    submitted = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/work/submit",
        headers=_auth(first_token),
        json={
            "version": started["version"],
            "request_id": str(uuid4()),
            "summary": "Done",
        },
    ).json()["issue"]
    reassigned = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items/{issue['id']}/assign",
        headers=_auth(test_token),
        json={
            "version": submitted["version"],
            "assignee_type": "user",
            "assignee_id": str(second.id),
        },
    )
    assert reassigned.status_code == 200, reassigned.text
    assert reassigned.json()["status"] == "pending"
    assert reassigned.json()["human_work"]["state"] == "none"
    second_view = test_client.get(
        f"/api/v1/loop-items/{issue['id']}", headers=_auth(second_token)
    ).json()
    assert second_view["human_work"]["can_start"] is True
    old_view = test_client.get(
        f"/api/v1/loop-items/{issue['id']}", headers=_auth(first_token)
    ).json()
    assert old_view["human_work"]["can_start"] is False
