# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Direct human Issue dispatch through a personal runtime task."""

import logging
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.delivery import CloudProject, LoopNode
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.issue_assignments import issue_assignment_service
from tests.utils.collaboration import authorize_project


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("notify_assignee", [True, False])
def test_create_assigned_issue_records_wakeup_intake(
    test_client: TestClient,
    test_token: str,
    test_user: User,
    test_db: Session,
    direct_human_project: CloudProject,
    caplog: pytest.LogCaptureFixture,
    notify_assignee: bool,
) -> None:
    caplog.set_level(logging.INFO)
    response = test_client.post(
        f"/api/v1/cloud-projects/{direct_human_project.id}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Merge GitHub PR wecode-ai/Wegent#4680",
            "description": "Private instructions must not enter diagnostic logs",
            "status": "pending",
            "assignee_user_id": test_user.id,
            "tags": ["quality gate"],
            "notify_assignee": notify_assignee,
        },
    )
    assert response.status_code == 201, response.text
    issue_id = response.json()["id"]
    events = (
        test_db.query(LoopNode)
        .filter_by(resource_type="stand_in_issue_event", user_id=test_user.id)
        .all()
    )
    assert len(events) == int(notify_assignee)
    if notify_assignee:
        assert events[0].metadata_json["itemId"] == issue_id
        assert (
            events[0].metadata_json["assignmentId"]
            == response.json()["human_task_binding"]["assignmentId"]
        )
        assert "Stand-in Issue wakeup staged" in caplog.text
    else:
        assert "reason=notify_assignee_false" in caplog.text
    assert issue_id in caplog.text
    assert "Private instructions must not enter diagnostic logs" not in caplog.text


@pytest.fixture
def direct_human_project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"HUMAN{uuid4().hex[:5].upper()}",
        name="Human dispatch",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


@pytest.mark.parametrize("notify_target", [True, False])
@pytest.mark.parametrize("assignment_api", ["project", "issue"])
def test_explicit_self_assignment_wakeup_matches_notification_choice(
    test_client: TestClient,
    test_token: str,
    test_user: User,
    test_db: Session,
    direct_human_project: CloudProject,
    notify_target: bool,
    assignment_api: str,
) -> None:
    project_id = direct_human_project.id
    created = test_client.post(
        f"/api/v1/cloud-projects/{project_id}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Review release notes",
            "status": "pending",
            "notify_assignee": False,
        },
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    issue_id = issue["id"]
    cleared = test_client.patch(
        f"/api/v1/loop-items/{issue_id}",
        headers=_auth(test_token),
        json={"version": issue["version"], "assignee_user_id": None},
    )
    assert cleared.status_code == 200, cleared.text
    if assignment_api == "project":
        assigned = test_client.post(
            f"/api/v1/cloud-projects/{project_id}/loop-items/{issue_id}/assign",
            headers=_auth(test_token),
            json={
                "version": cleared.json()["version"],
                "assigneeType": "user",
                "assigneeId": str(test_user.id),
                "notifyAssignee": notify_target,
            },
        )
        assert assigned.status_code == 200, assigned.text
        binding = assigned.json()["human_task_binding"]
    else:
        assigned = test_client.post(
            f"/api/v1/loop-items/{issue_id}/assignments",
            headers=_auth(test_token),
            json={
                "target_type": "human",
                "target_id": str(test_user.id),
                "notify_target": notify_target,
            },
        )
        assert assigned.status_code == 201, assigned.text
        binding = assigned.json()["issue"]["human_task_binding"]
    events = (
        test_db.query(LoopNode)
        .filter_by(resource_type="stand_in_issue_event", user_id=test_user.id)
        .all()
    )
    assert len(events) == int(notify_target)
    if notify_target:
        assert events[0].metadata_json["itemId"] == issue_id
        assert events[0].metadata_json["assignmentId"] == binding["assignmentId"]


def test_direct_human_assignment_notification_opens_original_issue(
    test_client: TestClient,
    test_token: str,
    test_user: User,
    test_db: Session,
    direct_human_project: CloudProject,
) -> None:
    assignee_name = f"direct-human-{uuid4().hex[:8]}"
    assignee = User(
        user_name=assignee_name,
        password_hash=get_password_hash("direct-human-password"),
        email=f"{assignee_name}@example.com",
        is_active=True,
    )
    test_db.add(assignee)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=direct_human_project.id,
            entity_id=str(assignee.id),
            role="Developer",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    created = test_client.post(
        f"/api/v1/cloud-projects/{direct_human_project.id}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Prepare release notes",
            "description": "Summarize the verified release changes.",
            "status": "pending",
        },
    )
    assert created.status_code == 201

    assigned = test_client.post(
        f"/api/v1/loop-items/{created.json()['id']}/assignments",
        headers=_auth(test_token),
        json={"target_type": "human", "target_id": str(assignee.id)},
    )

    assert assigned.status_code == 201, assigned.text
    notification = (
        test_db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == assignee.id,
            WeworkNotification.kind == "issue_dispatch_assignment",
        )
        .one()
    )
    payload = notification.payload
    assert payload["actorName"] == test_user.user_name
    assert payload["action"] == "open_issue"
    assert payload["itemId"] == created.json()["id"]
    assert payload["taskTitle"] == "Prepare release notes"
    assert payload["instructions"] == "Summarize the verified release changes."
    assert payload["roundId"] == "direct"
    assert payload["humanAssignmentId"]
    assert notification.url == (
        f"wework://boards/{direct_human_project.id}/issues/{created.json()['id']}"
    )


def test_explicit_redelivery_replaces_only_current_human_assignment(
    test_client: TestClient,
    test_token: str,
    test_user: User,
    test_db: Session,
    direct_human_project: CloudProject,
) -> None:
    headers = _auth(test_token)
    created = test_client.post(
        f"/api/v1/cloud-projects/{direct_human_project.id}/loop-items",
        headers=headers,
        json={
            "title": "Review changes",
            "status": "pending",
            "assignee_user_id": test_user.id,
        },
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    issue_id = issue["id"]
    original_id = issue["human_task_binding"]["assignmentId"]
    url = f"/api/v1/loop-items/{issue_id}"
    repeated = test_client.patch(
        url,
        headers=headers,
        json={"version": issue["version"], "assignee_user_id": test_user.id},
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["human_task_binding"]["assignmentId"] == original_id
    assert repeated.json()["assignment_history"][-1]["action"] == "reassign"
    assert "redeliver" not in repeated.json()["assignment_history"][-1]

    workflow, _ = issue_assignment_service.record(
        test_db,
        project_id=direct_human_project.id,
        issue_id=issue_id,
        member_type="human",
        member_id=str(test_user.id),
        assigned_by_user_id=test_user.id,
        workflow_step="review",
        notify=False,
        trigger="manual",
    )
    test_db.commit()
    redelivery = {
        "version": repeated.json()["version"],
        "assignee_user_id": test_user.id,
        "notify_assignee": True,
        "redeliver": True,
    }
    response = test_client.patch(url, headers=headers, json=redelivery)

    assert response.status_code == 200, response.text
    assert response.json()["id"] == issue_id
    assert response.json()["assignee_user_id"] == test_user.id
    assert response.json()["status"] == issue["status"]
    assert response.json()["title"] == issue["title"]
    history = response.json()["assignment_history"]
    assert history[:-1] == repeated.json()["assignment_history"]
    assert history[-1]["action"] == "reassign"
    assert history[-1]["redeliver"] is True
    assert history[-1]["to_id"] == str(test_user.id)
    assert (
        test_client.get(url, headers=headers).json()["assignment_history"][-1]
        == history[-1]
    )
    assert test_client.patch(url, headers=headers, json=redelivery).status_code == 409
    test_db.expire_all()
    active = issue_assignment_service.active_for_issue(test_db, issue_id)
    direct = next(event for event in active if not event.workflow_step)
    assert direct.id != original_id
    assert direct.metadata["trigger"] == "redelivery"
    assert direct.metadata["dispatch_receipt"]["state"] == "queued"
    assert {event.id for event in active} == {direct.id, workflow.id}
    original = test_db.get(LoopNode, original_id)
    assert original.metadata_json["dispatch_receipt"]["state"] == "cancelled"

    events = (
        test_db.query(LoopNode)
        .filter_by(resource_type="stand_in_issue_event", user_id=test_user.id)
        .all()
    )
    assert {event.metadata_json["assignmentId"] for event in events} == {
        original_id,
        direct.id,
    }
    notifications = (
        test_db.query(WeworkNotification)
        .filter_by(user_id=test_user.id, kind="issue_dispatch_assignment")
        .all()
    )
    assert {notification.payload["assignmentId"] for notification in notifications} == {
        original_id,
        direct.id,
    }
