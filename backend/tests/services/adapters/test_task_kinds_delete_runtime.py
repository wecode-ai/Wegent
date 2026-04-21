from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


def _create_mock_task_resource(task_id: int, user_id: int) -> Mock:
    task = Mock(spec=TaskResource)
    task.id = task_id
    task.user_id = user_id
    task.kind = "Task"
    task.is_active = TaskResource.STATE_ACTIVE
    task.updated_at = datetime.now()
    task.json = {
        "kind": "Task",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": {"taskType": "chat"},
        },
        "spec": {
            "title": "Test Task",
            "prompt": "Test prompt",
            "teamRef": {"name": "test-team", "namespace": "default"},
            "workspaceRef": {"name": "workspace-1", "namespace": "default"},
        },
        "status": {
            "status": "COMPLETED",
            "progress": 100,
            "createdAt": datetime.now().isoformat(),
            "updatedAt": datetime.now().isoformat(),
        },
    }
    return task


@pytest.mark.unit
def test_delete_task_terminates_sandbox_runtime_before_soft_delete():
    service = TaskKindsService(Kind)
    db = Mock(spec=Session)
    task = _create_mock_task_resource(100, 1)
    subtask = Mock(spec=Subtask)
    subtask.task_id = 100
    subtask.executor_name = None
    subtask.executor_namespace = None
    subtask.executor_deleted_at = False

    task_query = MagicMock()
    task_query.filter.return_value = task_query
    task_query.first.return_value = task

    subtask_query = MagicMock()
    subtask_query.filter.return_value = subtask_query
    subtask_query.all.return_value = [subtask]
    subtask_query.update.return_value = 1

    def query_side_effect(model):
        if model == TaskResource:
            return task_query
        if model == Subtask:
            return subtask_query
        raise AssertionError(f"Unexpected model query: {model}")

    db.query.side_effect = query_side_effect

    with (
        patch.object(service, "_cleanup_task_memories"),
        patch("app.services.adapters.task_kinds.operations.flag_modified"),
        patch(
            "app.services.execution.get_executor_runtime_client",
        ) as runtime_client_factory,
    ):
        runtime_client = MagicMock()
        runtime_client.get_sandbox = AsyncMock(
            return_value=({"status": "running", "base_url": "http://sandbox"}, None)
        )
        runtime_client.delete_sandbox = AsyncMock(return_value=(True, None))
        runtime_client_factory.return_value = runtime_client

        service.delete_task(db=db, task_id=100, user_id=1)

    runtime_client.get_sandbox.assert_awaited_once_with("100")
    runtime_client.delete_sandbox.assert_awaited_once_with("100")
    db.commit.assert_called_once()


@pytest.mark.unit
def test_delete_task_falls_back_to_executor_cleanup_when_no_sandbox():
    service = TaskKindsService(Kind)
    db = Mock(spec=Session)
    task = _create_mock_task_resource(101, 1)
    subtask = Mock(spec=Subtask)
    subtask.task_id = 101
    subtask.executor_name = "executor-1"
    subtask.executor_namespace = "wb-plat-ide"
    subtask.executor_deleted_at = False

    task_query = MagicMock()
    task_query.filter.return_value = task_query
    task_query.first.return_value = task

    subtask_query = MagicMock()
    subtask_query.filter.return_value = subtask_query
    subtask_query.all.return_value = [subtask]
    subtask_query.update.return_value = 1

    def query_side_effect(model):
        if model == TaskResource:
            return task_query
        if model == Subtask:
            return subtask_query
        raise AssertionError(f"Unexpected model query: {model}")

    db.query.side_effect = query_side_effect

    with (
        patch.object(service, "_cleanup_task_memories"),
        patch("app.services.adapters.task_kinds.operations.flag_modified"),
        patch(
            "app.services.execution.get_executor_runtime_client"
        ) as runtime_client_factory,
        patch(
            "app.services.adapters.task_kinds.operations.executor_kinds_service"
        ) as executor_service,
    ):
        runtime_client = MagicMock()
        runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        runtime_client.delete_sandbox = AsyncMock(return_value=(True, None))
        runtime_client_factory.return_value = runtime_client
        executor_service.delete_executor_task_sync.return_value = {"status": "success"}

        service.delete_task(db=db, task_id=101, user_id=1)

    runtime_client.get_sandbox.assert_awaited_once_with("101")
    runtime_client.delete_sandbox.assert_not_awaited()
    executor_service.delete_executor_task_sync.assert_called_once_with(
        "executor-1",
        "wb-plat-ide",
    )
    db.commit.assert_called_once()
