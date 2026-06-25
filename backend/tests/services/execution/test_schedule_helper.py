from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.kind import Kind
from app.models.subtask import SubtaskStatus
from app.services.execution.schedule_helper import (
    _dispatch_task_async,
    _extract_device_id_from_executor_name,
)
from shared.models import ExecutionRequest


def test_extract_device_id_from_executor_name_returns_device_id() -> None:
    device_id = "91762459-9e54-46b6-a9fa-eca8f30e9d2e"

    result = _extract_device_id_from_executor_name(f"device-{device_id}")

    assert result == device_id


def test_extract_device_id_from_executor_name_ignores_non_device_executor() -> None:
    assert _extract_device_id_from_executor_name("executor-123") is None
    assert _extract_device_id_from_executor_name("") is None
    assert _extract_device_id_from_executor_name(None) is None


@pytest.mark.asyncio
async def test_dispatch_uses_team_ref_owner_when_same_name_team_exists() -> None:
    """schedule_dispatch should resolve Team by task.spec.teamRef.user_id."""
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=10,
        user_name="owner-a",
    )

    task = SimpleNamespace(
        id=100,
        user_id=10,
        kind="Task",
        json={
            "kind": "Task",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {"name": "task", "namespace": "default"},
            "spec": {
                "title": "Task",
                "prompt": "hello",
                "teamRef": {
                    "name": "same-team",
                    "namespace": "default",
                    "user_id": 20,
                },
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {"phase": "pending"},
        },
    )
    subtask = SimpleNamespace(
        id=200,
        task_id=100,
        status=SubtaskStatus.PENDING,
        prompt="hello",
        parent_id=None,
        executor_deleted_at=False,
        executor_name=None,
        executor_namespace=None,
    )
    owner_b_team = Kind(
        id=2,
        user_id=20,
        kind="Team",
        name="same-team",
        namespace="default",
        json={"kind": "Team", "metadata": {"name": "same-team"}},
        is_active=True,
    )
    built_request = ExecutionRequest(task_id=100, subtask_id=200)
    builder = MagicMock()
    builder.build.return_value = built_request

    with (
        patch(
            "app.api.dependencies.get_db",
            return_value=iter([db]),
        ),
        patch(
            "app.stores.tasks.task_store.get_by_id",
            return_value=task,
        ),
        patch(
            "app.stores.tasks.subtask_store.list_by_task_status",
            return_value=[subtask],
        ),
        patch("app.stores.tasks.subtask_store.update_status"),
        patch(
            "app.services.execution.request_builder.TaskRequestBuilder",
            return_value=builder,
        ),
        patch(
            "app.services.task_team_resolver.resolve_task_team_ref",
            return_value=owner_b_team,
        ) as resolve_task_team_ref,
        patch(
            "app.services.task_team_resolver.can_user_use_team",
            return_value=True,
        ) as can_user_use_team,
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.dispatch",
            AsyncMock(),
        ) as dispatch,
    ):
        await _dispatch_task_async(100)

    resolve_task_team_ref.assert_called_once()
    assert resolve_task_team_ref.call_args.args == (db,)
    assert resolve_task_team_ref.call_args.kwargs["fallback_user_id"] == 10
    resolved_team_ref = resolve_task_team_ref.call_args.kwargs["team_ref"]
    assert resolved_team_ref.user_id == 20
    can_user_use_team.assert_called_once_with(db, 10, owner_b_team)
    assert builder.build.call_args.kwargs["team"] is owner_b_team
    dispatch.assert_awaited_once_with(built_request, device_id=None)


@pytest.mark.asyncio
async def test_dispatch_marks_pending_subtask_failed_when_team_is_unauthorized() -> (
    None
):
    db = MagicMock()
    task = SimpleNamespace(
        id=100,
        user_id=10,
        kind="Task",
        json={
            "kind": "Task",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {"name": "task", "namespace": "default"},
            "spec": {
                "title": "Task",
                "prompt": "hello",
                "teamRef": {
                    "name": "team",
                    "namespace": "default",
                    "user_id": 20,
                },
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {"phase": "pending"},
        },
    )
    subtask = SimpleNamespace(id=200, task_id=100)
    team = Kind(
        id=2,
        user_id=20,
        kind="Team",
        name="team",
        namespace="default",
        json={"kind": "Team", "metadata": {"name": "team"}},
        is_active=True,
    )

    with (
        patch("app.api.dependencies.get_db", return_value=iter([db])),
        patch("app.stores.tasks.task_store.get_by_id", return_value=task),
        patch(
            "app.stores.tasks.subtask_store.list_by_task_status",
            return_value=[subtask],
        ),
        patch(
            "app.services.task_team_resolver.resolve_task_team_ref",
            return_value=team,
        ),
        patch(
            "app.services.task_team_resolver.can_user_use_team",
            return_value=False,
        ),
        patch("app.stores.tasks.subtask_store.update_fields") as update_fields,
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.dispatch",
            AsyncMock(),
        ) as dispatch,
    ):
        await _dispatch_task_async(100)

    update_fields.assert_called_once()
    assert update_fields.call_args.kwargs["subtask"] is subtask
    assert update_fields.call_args.kwargs["status"] == SubtaskStatus.FAILED
    assert "cannot use Team" in update_fields.call_args.kwargs["error_message"]
    db.commit.assert_called_once()
    dispatch.assert_not_awaited()
