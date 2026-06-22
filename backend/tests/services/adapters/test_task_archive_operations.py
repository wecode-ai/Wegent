# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.project import Project
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.task import TaskCreate
from app.services import project_service
from app.services.adapters.task_kinds import task_kinds_service
from app.services.chat.standalone_workspace import (
    WORKSPACE_PATH_LABEL,
    WORKSPACE_SOURCE_LABEL,
    extract_workspace_path,
    persist_standalone_workspace_path,
)


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
    client_origin: str = "frontend",
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
        client_origin=client_origin,
        created_at=timestamp - timedelta(hours=1),
        updated_at=timestamp,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _create_project(
    db: Session,
    user_id: int,
    project_id: int,
    name: str,
    *,
    client_origin: str = "frontend",
) -> Project:
    project = Project(
        id=project_id,
        user_id=user_id,
        name=name,
        description="",
        color="",
        client_origin=client_origin,
        sort_order=1,
        is_active=True,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _create_user(db: Session, name: str) -> User:
    user = User(
        user_name=name,
        password_hash="hash",
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _create_team_with_bot(db: Session, user_id: int, suffix: str) -> Kind:
    bot_name = f"bot-{suffix}"
    team_name = f"team-{suffix}"
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name=bot_name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": bot_name, "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "ghost", "namespace": "default"},
                "shellRef": {"name": "shell", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=team_name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": team_name, "namespace": "default"},
            "spec": {
                "members": [{"botRef": {"name": bot_name, "namespace": "default"}}],
                "collaborationModel": "coordinate",
                "description": "",
                "icon": "bot",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add_all([bot, team])
    db.commit()
    db.refresh(team)
    return team


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


def test_title_search_does_not_match_subtask_content(
    test_db: Session,
    test_user: User,
):
    task = _create_task(
        test_db,
        test_user.id,
        7109,
        "hi",
        client_origin="wework",
    )
    test_db.add(
        Subtask(
            user_id=test_user.id,
            task_id=task.id,
            team_id=1,
            title="assistant reply",
            bot_ids=[],
            prompt="ubuntu",
            result={"value": "assistant reply"},
            completed_at=datetime(2026, 5, 30, 8, 1, 0),
        )
    )
    test_db.commit()

    items, total = task_kinds_service.get_user_tasks_by_title_with_pagination(
        db=test_db,
        user_id=test_user.id,
        title="ubuntu",
        skip=0,
        limit=10,
    )

    assert total == 0
    assert items == []


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


def test_archive_standalone_chats_leaves_project_chats(
    test_db: Session,
    test_user: User,
):
    project = _create_project(test_db, test_user.id, 703, "wegent-dev")
    project_task = _create_task(
        test_db,
        test_user.id,
        7010,
        "Project chat",
        project_id=project.id,
    )
    standalone_chat = _create_task(
        test_db,
        test_user.id,
        7011,
        "Standalone chat",
    )

    count = task_kinds_service.archive_standalone_chats(
        test_db,
        user_id=test_user.id,
    )
    test_db.refresh(project_task)
    test_db.refresh(standalone_chat)

    assert count == 1
    assert project_task.is_active == TaskResource.STATE_ACTIVE
    assert standalone_chat.is_active == TaskResource.STATE_ARCHIVED


def test_personal_task_list_filters_by_client_origin(
    test_db: Session,
    test_user: User,
):
    frontend_task = _create_task(
        test_db,
        test_user.id,
        7020,
        "Frontend standalone chat",
        client_origin="frontend",
    )
    wework_task = _create_task(
        test_db,
        test_user.id,
        7021,
        "Wework standalone chat",
        client_origin="wework",
    )

    items, total = task_kinds_service.get_user_personal_tasks_lite(
        test_db,
        user_id=test_user.id,
        types=["online", "offline"],
        client_origin="wework",
    )

    assert total == 1
    assert [item["id"] for item in items] == [wework_task.id]
    assert frontend_task.id not in [item["id"] for item in items]


def test_archive_standalone_chats_filters_by_client_origin(
    test_db: Session,
    test_user: User,
):
    frontend_task = _create_task(
        test_db,
        test_user.id,
        7022,
        "Frontend standalone chat",
        client_origin="frontend",
    )
    wework_task = _create_task(
        test_db,
        test_user.id,
        7023,
        "Wework standalone chat",
        client_origin="wework",
    )

    count = task_kinds_service.archive_standalone_chats(
        test_db,
        user_id=test_user.id,
        client_origin="wework",
    )
    test_db.refresh(frontend_task)
    test_db.refresh(wework_task)

    assert count == 1
    assert frontend_task.is_active == TaskResource.STATE_ACTIVE
    assert wework_task.is_active == TaskResource.STATE_ARCHIVED


def test_task_detail_filters_by_client_origin(
    test_db: Session,
    test_user: User,
):
    wework_task = _create_task(
        test_db,
        test_user.id,
        7024,
        "Wework standalone chat",
        client_origin="wework",
    )

    detail = task_kinds_service.get_task_detail(
        test_db,
        task_id=wework_task.id,
        user_id=test_user.id,
        client_origin="wework",
    )

    assert detail["id"] == wework_task.id
    assert detail["client_origin"] == "wework"

    with pytest.raises(HTTPException) as exc_info:
        task_kinds_service.get_task_detail(
            test_db,
            task_id=wework_task.id,
            user_id=test_user.id,
            client_origin="frontend",
        )

    assert exc_info.value.status_code == 404


def test_append_existing_task_filters_by_client_origin(
    test_db: Session,
    test_user: User,
):
    wework_task = _create_task(
        test_db,
        test_user.id,
        7026,
        "Wework completed chat",
        client_origin="wework",
    )

    with pytest.raises(HTTPException) as exc_info:
        task_kinds_service.create_task_or_append(
            test_db,
            obj_in=TaskCreate(
                prompt="append from frontend",
                client_origin="frontend",
            ),
            user=test_user,
            task_id=wework_task.id,
        )

    assert exc_info.value.status_code == 404


def test_append_existing_task_rejects_non_owner_non_member(
    test_db: Session,
    test_user: User,
):
    other_user = _create_user(test_db, "append-outsider")
    task = _create_task(
        test_db,
        test_user.id,
        7027,
        "Owner completed chat",
        client_origin="frontend",
    )

    with pytest.raises(HTTPException) as exc_info:
        task_kinds_service.create_task_or_append(
            test_db,
            obj_in=TaskCreate(
                prompt="unauthorized append",
                client_origin="frontend",
            ),
            user=other_user,
            task_id=task.id,
        )

    test_db.refresh(task)
    subtasks = test_db.query(Subtask).filter(Subtask.task_id == task.id).all()
    assert exc_info.value.status_code == 404
    assert task.json["status"]["status"] == "COMPLETED"
    assert subtasks == []


def test_append_existing_subscription_task_is_not_treated_as_regular_active_task(
    test_db: Session,
    test_user: User,
):
    task = _create_task(
        test_db,
        test_user.id,
        7028,
        "Subscription task",
        state=TaskResource.STATE_SUBSCRIPTION,
        type_value="subscription",
    )

    with pytest.raises(HTTPException) as exc_info:
        task_kinds_service.create_task_or_append(
            test_db,
            obj_in=TaskCreate(
                prompt="regular append should not target subscription",
                client_origin="frontend",
            ),
            user=test_user,
            task_id=task.id,
        )

    test_db.refresh(task)
    subtasks = test_db.query(Subtask).filter(Subtask.task_id == task.id).all()
    assert exc_info.value.status_code == 404
    assert task.is_active == TaskResource.STATE_SUBSCRIPTION
    assert task.json["status"]["status"] == "COMPLETED"
    assert subtasks == []


def test_create_task_creates_workspace_task_user_and_assistant_subtasks(
    test_db: Session,
    test_user: User,
):
    team = _create_team_with_bot(test_db, test_user.id, "create-task")

    result = task_kinds_service.create_task_or_append(
        test_db,
        obj_in=TaskCreate(
            team_id=team.id,
            title="Create task store path",
            prompt="Run store-backed task creation",
            task_type="task",
            git_url="https://example.com/repo.git",
            git_repo="repo",
            git_repo_id=42,
            git_domain="example.com",
            branch_name="main",
        ),
        user=test_user,
    )

    task_id = result["id"]
    task = test_db.get(TaskResource, task_id)
    workspace = (
        test_db.query(TaskResource)
        .filter(
            TaskResource.user_id == test_user.id,
            TaskResource.kind == "Workspace",
            TaskResource.name == f"workspace-{task_id}",
            TaskResource.namespace == "default",
        )
        .first()
    )
    subtasks = (
        test_db.query(Subtask)
        .filter(Subtask.task_id == task_id)
        .order_by(Subtask.message_id.asc())
        .all()
    )

    assert task is not None
    assert task.kind == "Task"
    assert task.json["spec"]["title"] == "Create task store path"
    assert workspace is not None
    assert workspace.json["spec"]["repository"]["gitRepo"] == "repo"
    assert [subtask.role for subtask in subtasks] == [
        SubtaskRole.USER,
        SubtaskRole.ASSISTANT,
    ]
    assert subtasks[0].prompt == "Run store-backed task creation"
    assert subtasks[0].status == SubtaskStatus.COMPLETED
    assert subtasks[1].status == SubtaskStatus.PENDING


def test_archive_all_project_chats_leaves_standalone_chats(
    test_db: Session,
    test_user: User,
):
    project = _create_project(test_db, test_user.id, 704, "daily-tasks")
    project_task = _create_task(
        test_db,
        test_user.id,
        7012,
        "Project chat",
        project_id=project.id,
    )
    standalone_chat = _create_task(
        test_db,
        test_user.id,
        7013,
        "Standalone chat",
    )

    count = task_kinds_service.archive_all_project_chats(
        test_db,
        user_id=test_user.id,
    )
    test_db.refresh(project_task)
    test_db.refresh(standalone_chat)

    assert count == 1
    assert project_task.is_active == TaskResource.STATE_ARCHIVED
    assert standalone_chat.is_active == TaskResource.STATE_ACTIVE


def test_project_list_filters_by_client_origin(
    test_db: Session,
    test_user: User,
):
    _create_project(
        test_db,
        test_user.id,
        705,
        "frontend-project",
        client_origin="frontend",
    )
    wework_project = _create_project(
        test_db,
        test_user.id,
        706,
        "wework-project",
        client_origin="wework",
    )
    _create_task(
        test_db,
        test_user.id,
        7025,
        "Wework project chat",
        project_id=wework_project.id,
        client_origin="wework",
    )

    result = project_service.list_projects(
        test_db,
        user_id=test_user.id,
        include_tasks=True,
        client_origin="wework",
    )

    assert result.total == 1
    assert result.items[0].id == wework_project.id
    assert result.items[0].client_origin == "wework"
    assert [task.task_id for task in result.items[0].tasks] == [7025]


def test_persist_standalone_workspace_path_updates_task_labels(
    test_db: Session,
    test_user: User,
):
    task = _create_task(test_db, test_user.id, 7014, "Standalone chat")

    changed = persist_standalone_workspace_path(
        test_db,
        task_id=task.id,
        workspace_path="/tmp/chats/2026-05-29/standalone-chat",
    )
    test_db.refresh(task)

    labels = task.json["metadata"]["labels"]
    assert changed is True
    assert labels[WORKSPACE_PATH_LABEL] == "/tmp/chats/2026-05-29/standalone-chat"
    assert labels[WORKSPACE_SOURCE_LABEL] == "local_path"
    assert (
        extract_workspace_path(
            {"standalone_chat_workspace_path": " /tmp/chats/example "}
        )
        == "/tmp/chats/example"
    )


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
    test_db.add_all(
        [
            Subtask(
                user_id=test_user.id,
                task_id=task.id,
                team_id=1,
                title="user",
                bot_ids=[],
                role=SubtaskRole.USER,
                status=SubtaskStatus.COMPLETED,
                prompt="hello",
                message_id=1,
                parent_id=0,
                completed_at=datetime(2026, 5, 28, 10, 0, 0),
            ),
            Subtask(
                user_id=test_user.id,
                task_id=task.id,
                team_id=1,
                title="assistant",
                bot_ids=[],
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
                prompt="",
                executor_namespace="default",
                executor_name="executor-1",
                message_id=2,
                parent_id=1,
                completed_at=datetime(2026, 5, 28, 10, 0, 0),
            ),
        ]
    )
    test_db.commit()

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
    subtasks = test_db.query(Subtask).filter(Subtask.task_id == task.id).all()

    assert task.is_active == TaskResource.STATE_DELETED
    assert {subtask.status for subtask in subtasks} == {SubtaskStatus.DELETE}
    assert all(subtask.executor_deleted_at is True for subtask in subtasks)
