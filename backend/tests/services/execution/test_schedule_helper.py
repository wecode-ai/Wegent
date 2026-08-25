from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.schedule_helper import (
    _dispatch_task_async,
    _extract_device_id_from_executor_name,
)


def test_extract_device_id_from_executor_name_returns_device_id() -> None:
    device_id = "91762459-9e54-46b6-a9fa-eca8f30e9d2e"

    result = _extract_device_id_from_executor_name(f"device-{device_id}")

    assert result == device_id


def test_extract_device_id_from_executor_name_ignores_non_device_executor() -> None:
    assert _extract_device_id_from_executor_name("executor-123") is None
    assert _extract_device_id_from_executor_name("") is None
    assert _extract_device_id_from_executor_name(None) is None


@pytest.mark.asyncio
async def test_scheduled_task_dispatch_uses_task_model_override() -> None:
    """Background dispatch must keep the model selection persisted on a Task."""
    db = MagicMock()
    task = SimpleNamespace(
        id=570,
        kind="Task",
        user_id=7,
        json={
            "metadata": {
                "labels": {
                    "modelId": "kimi-k2-7",
                    "forceOverrideBotModel": "true",
                    "forceOverrideBotModelType": "public",
                }
            }
        },
    )
    subtask = SimpleNamespace(
        id=947,
        executor_deleted_at=False,
        executor_name="",
        executor_namespace="default",
    )
    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="code-wiki-team", namespace="default")
        )
    )
    builder = MagicMock()
    builder.build.return_value = MagicMock()
    user = MagicMock()

    with (
        patch("app.api.dependencies.get_db", return_value=iter((db,))),
        patch("app.stores.tasks.task_store.get_by_id", return_value=task),
        patch(
            "app.stores.tasks.subtask_store.list_by_task_status",
            return_value=[subtask],
        ),
        patch("app.schemas.kind.Task.model_validate", return_value=task_crd),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=MagicMock(),
        ),
        patch.object(
            db.query.return_value.filter.return_value,
            "first",
            return_value=user,
        ),
        patch(
            "app.services.execution.request_builder.TaskRequestBuilder",
            return_value=builder,
        ),
        patch(
            "app.services.execution.schedule_helper._resolve_dispatch_message",
            return_value="write the wiki",
        ),
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.dispatch",
            new=AsyncMock(),
        ),
    ):
        await _dispatch_task_async(task.id)

    assert builder.build.call_args.kwargs["override_model_name"] == "kimi-k2-7"
    assert builder.build.call_args.kwargs["force_override"] is True


@pytest.mark.asyncio
async def test_scheduled_task_dispatch_skips_pod_check_for_device_executor() -> None:
    """Device executors are not executor-manager pods and must not be recovered."""
    db = MagicMock()
    task = SimpleNamespace(
        id=571,
        kind="Task",
        user_id=7,
        json={},
    )
    subtask = SimpleNamespace(
        id=948,
        executor_deleted_at=False,
        executor_name="device-local-1",
        executor_namespace="user-7",
    )
    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="code-wiki-team", namespace="default")
        )
    )
    request = MagicMock()
    builder = MagicMock()
    builder.build.return_value = request
    user = MagicMock()
    dispatch_mock = AsyncMock()

    with (
        patch("app.api.dependencies.get_db", return_value=iter((db,))),
        patch("app.stores.tasks.task_store.get_by_id", return_value=task),
        patch(
            "app.stores.tasks.subtask_store.list_by_task_status",
            return_value=[subtask],
        ),
        patch("app.schemas.kind.Task.model_validate", return_value=task_crd),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=MagicMock(),
        ),
        patch.object(
            db.query.return_value.filter.return_value,
            "first",
            return_value=user,
        ),
        patch(
            "app.services.execution.request_builder.TaskRequestBuilder",
            return_value=builder,
        ),
        patch(
            "app.services.execution.schedule_helper._resolve_dispatch_message",
            return_value="continue",
        ),
        patch(
            "app.services.execution.schedule_helper._executor_pod_missing",
            new=AsyncMock(return_value=True),
        ) as pod_missing_mock,
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.dispatch",
            new=dispatch_mock,
        ),
    ):
        await _dispatch_task_async(task.id)

    pod_missing_mock.assert_not_awaited()
    dispatch_mock.assert_awaited_once_with(request, device_id="local-1")
