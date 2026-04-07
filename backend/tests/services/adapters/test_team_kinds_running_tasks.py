# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.team_kinds import team_kinds_service


def _create_user(test_db: Session, user_name: str, email: str) -> User:
    user = User(
        user_name=user_name,
        password_hash=get_password_hash("testpassword123"),
        email=email,
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_team(
    test_db: Session, *, user_id: int, team_name: str, namespace: str = "default"
) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=team_name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": team_name, "namespace": namespace},
            "spec": {"collaborationModel": "sequential", "members": []},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def _create_task(
    test_db: Session,
    *,
    task_name: str,
    task_user_id: int,
    team_name: str,
    team_namespace: str,
    team_owner_user_id: int,
    status: str,
) -> TaskResource:
    now = datetime.now().isoformat()
    task = TaskResource(
        user_id=task_user_id,
        kind="Task",
        name=task_name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": task_name, "namespace": "default", "labels": {}},
            "spec": {
                "title": task_name,
                "prompt": "prompt",
                "teamRef": {
                    "name": team_name,
                    "namespace": team_namespace,
                    "user_id": team_owner_user_id,
                },
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {
                "status": status,
                "progress": 0,
                "result": None,
                "errorMessage": "",
                "createdAt": now,
                "updatedAt": now,
                "completedAt": None,
            },
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    return task


@pytest.mark.integration
def test_check_running_tasks_ignores_other_users_default_team_tasks(
    test_db: Session, test_user: User
):
    owner_team = _create_team(test_db, user_id=test_user.id, team_name="shared-name")
    other_user = _create_user(test_db, "otheruser", "other@example.com")
    _create_team(test_db, user_id=other_user.id, team_name="shared-name")

    _create_task(
        test_db,
        task_name="owner-completed-task",
        task_user_id=test_user.id,
        team_name=owner_team.name,
        team_namespace=owner_team.namespace,
        team_owner_user_id=test_user.id,
        status="COMPLETED",
    )
    _create_task(
        test_db,
        task_name="other-running-task",
        task_user_id=other_user.id,
        team_name=owner_team.name,
        team_namespace=owner_team.namespace,
        team_owner_user_id=other_user.id,
        status="RUNNING",
    )

    result = team_kinds_service.check_running_tasks(
        test_db, team_id=owner_team.id, user_id=test_user.id
    )

    assert result["has_running_tasks"] is False
    assert result["running_tasks_count"] == 0
    assert result["running_tasks"] == []


@pytest.mark.integration
def test_delete_with_user_allows_deleting_default_team_when_only_other_user_has_running_task(
    test_db: Session, test_user: User
):
    owner_team = _create_team(test_db, user_id=test_user.id, team_name="deletable-team")
    other_user = _create_user(test_db, "anotheruser", "another@example.com")
    _create_team(test_db, user_id=other_user.id, team_name="deletable-team")

    _create_task(
        test_db,
        task_name="other-running-task",
        task_user_id=other_user.id,
        team_name=owner_team.name,
        team_namespace=owner_team.namespace,
        team_owner_user_id=other_user.id,
        status="RUNNING",
    )

    team_kinds_service.delete_with_user(
        test_db, team_id=owner_team.id, user_id=test_user.id
    )

    deleted_team = test_db.query(Kind).filter(Kind.id == owner_team.id).first()
    assert deleted_team is None
