# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.task_kinds import task_kinds_service


def _task_json(
    task_id: int,
    title: str,
    *,
    task_type: str = "code",
    type_value: str = "offline",
    status: str = "COMPLETED",
) -> dict:
    now = datetime(2026, 5, 28, 10, 0, 0).isoformat()
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": {
                "taskType": task_type,
                "type": type_value,
            },
        },
        "spec": {
            "title": title,
            "prompt": title,
            "teamRef": {"name": "coder", "namespace": "default"},
            "workspaceRef": {"name": f"workspace-{task_id}", "namespace": "default"},
        },
        "status": {
            "state": "Available",
            "status": status,
            "progress": 100,
            "createdAt": now,
            "updatedAt": now,
            "completedAt": now,
        },
    }


def _create_task(
    db: Session,
    user_id: int,
    task_id: int,
    title: str,
    *,
    project_id: int = 0,
    state: int = TaskResource.STATE_ACTIVE,
    task_type: str = "code",
    type_value: str = "offline",
    updated_at: datetime | None = None,
) -> TaskResource:
    timestamp = updated_at or datetime(2026, 5, 28, 10, 0, 0)
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json=_task_json(
            task_id,
            title,
            task_type=task_type,
            type_value=type_value,
        ),
        is_active=state,
        project_id=project_id,
        created_at=timestamp - timedelta(hours=1),
        updated_at=timestamp,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _create_project(db: Session, user_id: int, project_id: int, name: str) -> Project:
    project = Project(
        id=project_id,
        user_id=user_id,
        name=name,
        description="",
        color="",
        sort_order=1,
        is_active=True,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def test_archive_task_hides_from_personal_list_and_preserves_timestamp(
    test_db: Session,
    test_user: User,
):
    project = _create_project(test_db, test_user.id, 701, "Wegent")
    original_updated_at = datetime(2026, 5, 27, 12, 15, 0)
    task = _create_task(
        test_db,
        test_user.id,
        7001,
        "Build project UI",
        project_id=project.id,
        updated_at=original_updated_at,
    )

    task_kinds_service.archive_task(
        test_db,
        task_id=task.id,
        user_id=test_user.id,
    )
    test_db.refresh(task)

    assert task.is_active == TaskResource.STATE_ARCHIVED
    assert task.updated_at == original_updated_at

    active_items, active_total = task_kinds_service.get_user_personal_tasks_lite(
        test_db,
        user_id=test_user.id,
        types=["online", "offline"],
    )
    assert active_items == []
    assert active_total == 0

    archived_items, archived_total = task_kinds_service.list_archived_tasks(
        test_db,
        user_id=test_user.id,
    )
    assert archived_total == 1
    assert archived_items[0].id == task.id
    assert archived_items[0].title == "Build project UI"
    assert archived_items[0].project_name == "Wegent"
    assert archived_items[0].updated_at == original_updated_at


def test_archive_all_and_project_archive_only_archive_chat_like_tasks(
    test_db: Session,
    test_user: User,
):
    project = _create_project(test_db, test_user.id, 702, "publish")
    project_task = _create_task(
        test_db,
        test_user.id,
        7002,
        "Project chat",
        project_id=project.id,
    )
    standalone_chat = _create_task(
        test_db,
        test_user.id,
        7003,
        "Standalone chat",
        task_type="chat",
        type_value="online",
    )
    subscription_task = _create_task(
        test_db,
        test_user.id,
        7004,
        "Subscription",
        task_type="chat",
        type_value="subscription",
    )

    project_count = task_kinds_service.archive_project_chats(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
    )
    test_db.refresh(project_task)
    test_db.refresh(standalone_chat)

    assert project_count == 1
    assert project_task.is_active == TaskResource.STATE_ARCHIVED
    assert standalone_chat.is_active == TaskResource.STATE_ACTIVE

    all_count = task_kinds_service.archive_all_user_chats(
        test_db,
        user_id=test_user.id,
    )
    test_db.refresh(standalone_chat)
    test_db.refresh(subscription_task)

    assert all_count == 1
    assert standalone_chat.is_active == TaskResource.STATE_ARCHIVED
    assert subscription_task.is_active == TaskResource.STATE_ACTIVE


def test_unarchive_restores_task_to_active_lists(
    test_db: Session,
    test_user: User,
):
    task = _create_task(
        test_db,
        test_user.id,
        7005,
        "Archived chat",
        state=TaskResource.STATE_ARCHIVED,
    )

    task_kinds_service.unarchive_task(
        test_db,
        task_id=task.id,
        user_id=test_user.id,
    )
    test_db.refresh(task)

    assert task.is_active == TaskResource.STATE_ACTIVE
    active_items, active_total = task_kinds_service.get_user_personal_tasks_lite(
        test_db,
        user_id=test_user.id,
        types=["online", "offline"],
    )
    assert active_total == 1
    assert active_items[0]["id"] == task.id


def test_delete_task_accepts_archived_tasks(
    test_db: Session,
    test_user: User,
):
    task = _create_task(
        test_db,
        test_user.id,
        7006,
        "Archived chat to delete",
        state=TaskResource.STATE_ARCHIVED,
    )

    runtime_client = MagicMock()
    runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
    runtime_client.delete_sandbox = AsyncMock(return_value=(True, None))
    execution_module = ModuleType("app.services.execution")
    execution_module.get_executor_runtime_client = MagicMock(
        return_value=runtime_client
    )

    with (
        patch.object(task_kinds_service, "_cleanup_task_memories"),
        patch.dict("sys.modules", {"app.services.execution": execution_module}),
    ):
        task_kinds_service.delete_task(
            test_db,
            task_id=task.id,
            user_id=test_user.id,
        )

    test_db.refresh(task)

    assert task.is_active == TaskResource.STATE_DELETED
