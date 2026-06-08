# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat task manager subtask creation."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.storage.task_manager import (
    TaskCreationParams,
    create_assistant_subtask,
    create_new_task,
    create_task_and_subtasks,
)


def test_create_assistant_subtask_inherits_deleted_executor_state_for_recovery(
    test_db: Session,
    test_user: User,
):
    """When previous executor was deleted, new subtask should carry recovery metadata."""
    previous_subtask = Subtask(
        user_id=test_user.id,
        task_id=1385,
        team_id=1256,
        title="Previous assistant response",
        bot_ids=[1255],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="default",
        executor_name="wegent-task-user7-pod7",
        executor_deleted_at=True,
        prompt="",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=12,
        parent_id=11,
        error_message="",
        result={"value": "done"},
        completed_at=datetime.now(),
    )
    test_db.add(previous_subtask)
    test_db.commit()

    assistant_subtask = create_assistant_subtask(
        db=test_db,
        subtask_user_id=test_user.id,
        task_id=1385,
        team_id=1256,
        bot_ids=[1255],
        next_message_id=14,
        parent_id=13,
    )
    test_db.flush()

    # Preserve the deleted executor metadata on the current subtask so
    # dispatcher recovery can restore the workspace without scanning history.
    assert assistant_subtask.executor_name == previous_subtask.executor_name
    assert assistant_subtask.executor_namespace == previous_subtask.executor_namespace
    assert assistant_subtask.executor_deleted_at is True


def test_create_new_task_uses_auto_delete_executor_label(
    test_db: Session,
    test_user: User,
):
    """New task labels should honor auto_delete_executor from API headers."""
    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    params = TaskCreationParams(
        message="run tests",
        auto_delete_executor="true",
    )

    with patch(
        "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
        return_value=[],
    ):
        task = create_new_task(test_db, test_user, team, params)

    assert task.json["metadata"]["labels"]["autoDeleteExecutor"] == "true"


def test_create_new_task_writes_execution_workspace(
    test_db: Session,
    test_user: User,
):
    """New worktree tasks should persist their execution workspace in Task spec."""
    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    params = TaskCreationParams(
        message="run tests",
        execution_workspace={
            "source": "git_worktree",
        },
    )

    with patch(
        "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
        return_value=[],
    ):
        task = create_new_task(test_db, test_user, team, params)

    assert task.json["spec"]["execution"] == {
        "workspace": {
            "source": "git_worktree",
        }
    }


def test_create_new_task_uses_real_task_row_without_placeholder(
    test_db: Session,
    test_user: User,
):
    """New chat tasks should not reserve a Placeholder row for their ID."""
    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    params = TaskCreationParams(
        message="run tests",
        execution_workspace={
            "source": "git_worktree",
        },
    )

    with patch(
        "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
        return_value=[],
    ):
        task = create_new_task(test_db, test_user, team, params)

    placeholders = (
        test_db.query(TaskResource)
        .filter(
            TaskResource.user_id == test_user.id,
            TaskResource.kind == "Placeholder",
        )
        .all()
    )
    assert task.id is not None
    assert task.kind == "Task"
    assert task.name == f"task-{task.id}"
    assert task.json["spec"]["workspaceRef"]["name"] == f"workspace-{task.id}"
    assert placeholders == []


@pytest.mark.asyncio
async def test_create_task_and_subtasks_prepares_git_worktree_with_real_task_id(
    test_db: Session,
    test_user: User,
):
    """Git worktree preparation should use the created Task ID."""
    project = Project(
        user_id=test_user.id,
        name="Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "git", "checkoutPath": "d837/Wegent"},
            "git": {"url": "https://github.com/wecode-ai/Wegent.git"},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    params = TaskCreationParams(
        message="run tests",
        project_id=project.id,
        client_origin="wework",
        execution_workspace={"source": "git_worktree"},
    )
    prepare_worktree_mock = AsyncMock(
        return_value={"source": "git_worktree", "path": "/workspace/worktrees/1/Wegent"}
    )

    with (
        patch(
            "app.services.chat.storage.task_manager.get_bot_ids_from_team",
            return_value=[1255],
        ),
        patch(
            "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
            return_value=[],
        ),
        patch(
            "app.services.project_service.prepare_git_worktree_for_task",
            prepare_worktree_mock,
        ),
        patch(
            "app.services.memory.is_memory_enabled_for_user",
            return_value=False,
        ),
        patch(
            "app.services.chat.trigger.group_chat.is_task_group_chat",
            return_value=False,
        ),
    ):
        result = await create_task_and_subtasks(
            db=test_db,
            user=test_user,
            team=team,
            message=params.message,
            params=params,
            should_trigger_ai=True,
        )

    prepare_worktree_mock.assert_awaited_once()
    assert prepare_worktree_mock.await_args.kwargs["task_id"] == result.task.id
    assert result.task.json["spec"]["execution"] == {
        "workspace": {"source": "git_worktree"}
    }
    assert result.user_subtask.task_id == result.task.id
    assert result.assistant_subtask is not None


def test_create_assistant_subtask_inherits_active_executor_state(
    test_db: Session,
    test_user: User,
):
    """When previous executor is active (not deleted), new subtask should inherit it."""
    previous_subtask = Subtask(
        user_id=test_user.id,
        task_id=2468,
        team_id=1256,
        title="Previous assistant response",
        bot_ids=[1255],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="test-namespace",
        executor_name="wegent-task-user7-pod7",
        executor_deleted_at=False,
        prompt="",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=2,
        parent_id=1,
        error_message="",
        result={"value": "done"},
        completed_at=datetime.now(),
    )
    test_db.add(previous_subtask)
    test_db.commit()

    assistant_subtask = create_assistant_subtask(
        db=test_db,
        subtask_user_id=test_user.id,
        task_id=2468,
        team_id=1256,
        bot_ids=[1255],
        next_message_id=4,
        parent_id=3,
    )
    test_db.flush()

    # When previous executor is active, new subtask should inherit it
    assert assistant_subtask.executor_name == previous_subtask.executor_name
    assert assistant_subtask.executor_namespace == previous_subtask.executor_namespace
    assert assistant_subtask.executor_deleted_at is False


def test_create_assistant_subtask_defaults_to_empty_when_no_previous(
    test_db: Session,
    test_user: User,
):
    """When no previous subtask exists, new subtask should have empty executor fields."""
    assistant_subtask = create_assistant_subtask(
        db=test_db,
        subtask_user_id=test_user.id,
        task_id=2468,
        team_id=1256,
        bot_ids=[1255],
        next_message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert assistant_subtask.executor_name == ""
    assert assistant_subtask.executor_namespace == ""
    assert assistant_subtask.executor_deleted_at is False


def _build_existing_task(task_id: int, user_id: int) -> TaskResource:
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {
                "title": "Existing task",
                "prompt": "Previous prompt",
                "teamRef": {
                    "name": "quickstart",
                    "namespace": "default",
                    "user_id": user_id,
                },
                "workspaceRef": {
                    "name": f"workspace-{task_id}",
                    "namespace": "default",
                },
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "COMPLETED",
                "progress": 100,
                "result": {"value": "done"},
                "errorMessage": "stale failure",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": datetime.now().isoformat(),
            },
        },
        is_active=True,
        is_group_chat=False,
    )


def _build_existing_running_task(task_id: int, user_id: int) -> TaskResource:
    task = _build_existing_task(task_id=task_id, user_id=user_id)
    task.json["status"]["status"] = "RUNNING"
    task.json["status"]["progress"] = 50
    task.json["status"]["completedAt"] = None
    return task


@pytest.mark.asyncio
async def test_create_task_and_subtasks_resets_existing_task_status_to_pending(
    test_db: Session,
    test_user: User,
):
    task = _build_existing_task(task_id=1385, user_id=test_user.id)
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)

    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    params = TaskCreationParams(message="restart the service")

    with (
        patch(
            "app.services.chat.storage.task_manager.get_bot_ids_from_team",
            return_value=[1255],
        ),
        patch(
            "app.services.chat.storage.task_manager.initialize_redis_chat_history",
            new=AsyncMock(),
        ),
        patch(
            "app.services.memory.is_memory_enabled_for_user",
            return_value=False,
        ),
        patch(
            "app.services.chat.trigger.group_chat.is_task_group_chat",
            return_value=False,
        ),
    ):
        result = await create_task_and_subtasks(
            db=test_db,
            user=test_user,
            team=team,
            message=params.message,
            params=params,
            task_id=task.id,
            should_trigger_ai=True,
        )

    status = result.task.json["status"]
    assert status["status"] == "PENDING"
    assert status["progress"] == 0
    assert status["errorMessage"] == ""
    assert result.assistant_subtask is not None


@pytest.mark.asyncio
async def test_create_task_and_subtasks_allows_pipeline_confirm_to_skip_status_check(
    test_db: Session,
    test_user: User,
):
    task = _build_existing_running_task(task_id=2469, user_id=test_user.id)
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)

    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    params = TaskCreationParams(
        message="continue to the next pipeline stage",
        skip_status_check=True,
    )

    with (
        patch(
            "app.services.chat.storage.task_manager.get_bot_ids_from_team",
            return_value=[1255],
        ),
        patch(
            "app.services.chat.storage.task_manager.initialize_redis_chat_history",
            new=AsyncMock(),
        ),
        patch(
            "app.services.memory.is_memory_enabled_for_user",
            return_value=False,
        ),
        patch(
            "app.services.chat.trigger.group_chat.is_task_group_chat",
            return_value=False,
        ),
    ):
        result = await create_task_and_subtasks(
            db=test_db,
            user=test_user,
            team=team,
            message=params.message,
            params=params,
            task_id=task.id,
            should_trigger_ai=True,
        )

    status = result.task.json["status"]
    assert status["status"] == "PENDING"
    assert status["progress"] == 0
    assert result.assistant_subtask is not None
