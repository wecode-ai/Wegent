# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Direct human Issue dispatch through a personal runtime task."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.delivery import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


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
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def test_direct_human_assignment_notifies_personal_task_action(
    test_client: TestClient,
    test_token: str,
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
    assert payload["action"] == "create_personal_task"
    assert payload["itemId"] == created.json()["id"]
    assert payload["taskTitle"] == "Prepare release notes"
    assert payload["instructions"] == "Summarize the verified release changes."
    assert payload["roundId"] == "direct"
    assert payload["humanAssignmentId"]
