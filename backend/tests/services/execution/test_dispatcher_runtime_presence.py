# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Recover confirmed missing runtimes even when cleanup left a stale DB flag."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.dispatcher import ExecutionDispatcher
from shared.models import ExecutionRequest


@pytest.fixture
def context():
    request = ExecutionRequest(
        task_id=42,
        subtask_id=43,
        message_id=4,
        user={"id": 7, "name": "user7"},
        bot=[{"shell_type": "ClaudeCode"}],
        executor_name="deleted-executor",
        executor_namespace="default",
    )
    subtask = SimpleNamespace(
        id=43,
        executor_name="deleted-executor",
        executor_namespace="default",
        executor_deleted_at=False,
        error_message="",
    )
    db = MagicMock()
    recovery = AsyncMock(
        return_value={
            "executor_name": "recovered-executor",
            "executor_namespace": "default",
        }
    )

    def update_fields(db, *, subtask, **fields):
        for key, value in fields.items():
            setattr(subtask, key, value)

    with (
        patch("app.services.execution.dispatcher.SessionLocal", return_value=db),
        patch(
            "app.services.execution.dispatcher.subtask_store.get_by_id",
            return_value=subtask,
        ),
        patch(
            "app.services.execution.dispatcher.subtask_store.update_fields",
            side_effect=update_fields,
        ) as update,
        patch(
            "app.services.execution.dispatcher.task_store.get_by_id",
            return_value=SimpleNamespace(id=42, json={}),
        ) as get_task,
        patch("app.services.execution.dispatcher.recovery_service.recover", recovery),
        patch(
            "app.services.remote_workspace_service.remote_workspace_service.executor_alive",
            return_value=False,
        ) as alive,
    ):
        yield SimpleNamespace(
            dispatcher=ExecutionDispatcher(),
            request=request,
            subtask=subtask,
            db=db,
            recovery=recovery,
            update=update,
            get_task=get_task,
            alive=alive,
        )


@pytest.mark.asyncio
async def test_missing_runtime_with_stale_flag_is_recovered(context):
    await context.dispatcher._recover_executor_if_needed(context.request)

    context.alive.assert_called_once_with("deleted-executor", "default")
    context.recovery.assert_awaited_once()
    assert context.update.call_args_list[0].kwargs["executor_deleted_at"] is True
    assert context.update.call_args_list[1].kwargs["executor_deleted_at"] is False
    assert context.db.commit.call_count == 2
    assert context.request.task_id == 42
    assert context.request.subtask_id == 43
    assert context.request.executor_name == "recovered-executor"
    assert context.subtask.executor_deleted_at is False


@pytest.mark.asyncio
@pytest.mark.parametrize("lookup_error", [False, True])
async def test_alive_or_unverified_runtime_is_not_marked_deleted(context, lookup_error):
    context.alive.return_value = True
    if lookup_error:
        context.alive.side_effect = RuntimeError("manager unavailable")

    await context.dispatcher._recover_executor_if_needed(context.request)

    context.alive.assert_called_once()
    context.recovery.assert_not_awaited()
    context.update.assert_not_called()
    context.get_task.assert_not_called()
    assert context.subtask.executor_deleted_at is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "device_id, executor_name", [("device-1", "old"), (None, "device-local")]
)
async def test_device_runtime_is_not_probed_as_kubernetes(
    context, device_id, executor_name
):
    context.subtask.executor_name = executor_name
    context.request.executor_name = executor_name

    await context.dispatcher._recover_executor_if_needed(
        context.request, device_id=device_id
    )

    context.alive.assert_not_called()
    context.recovery.assert_not_awaited()
    context.update.assert_not_called()


@pytest.mark.asyncio
async def test_confirmed_missing_runtime_stays_deleted_when_recovery_fails(context):
    context.recovery.return_value = None

    with pytest.raises(RuntimeError, match="Failed to recover executor"):
        await context.dispatcher._recover_executor_if_needed(context.request)

    assert context.subtask.executor_deleted_at is True
    assert context.request.executor_name == "deleted-executor"
    context.recovery.assert_awaited_once()
    context.db.close.assert_called_once()
