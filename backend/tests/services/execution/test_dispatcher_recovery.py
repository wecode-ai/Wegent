# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for executor recovery in the unified dispatch path."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import ExecutionRequest


@pytest.mark.asyncio
async def test_dispatch_recovers_deleted_executor_before_http_callback():
    """HTTP callback dispatch should recover a deleted executor before dispatching."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1385,
        subtask_id=1861,
        message_id=3,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
        executor_name="old-executor",
    )
    emitter = AsyncMock()

    subtask = MagicMock(spec=Subtask)
    subtask.executor_deleted_at = True
    subtask.executor_name = "old-executor"
    subtask.executor_namespace = ""

    task = MagicMock(spec=TaskResource)
    task.id = 1385
    task.kind = "Task"

    subtask_query = MagicMock()
    subtask_query.filter.return_value = subtask_query
    subtask_query.first.return_value = subtask

    task_query = MagicMock()
    task_query.filter.return_value = task_query
    task_query.first.return_value = task

    db = MagicMock()

    def query_side_effect(model):
        if model == Subtask:
            return subtask_query
        if model == TaskResource:
            return task_query
        return MagicMock()

    db.query.side_effect = query_side_effect

    async def recover_side_effect(*, db, subtask, task, request):
        subtask.executor_name = "recovered-executor"
        subtask.executor_namespace = "default"
        subtask.executor_deleted_at = False
        request.executor_name = "recovered-executor"
        request.executor_namespace = "default"
        return True

    recovery_service = MagicMock()
    recovery_service.recover = AsyncMock(side_effect=recover_side_effect)

    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    with (
        patch(
            "app.services.execution.dispatcher.SessionLocal",
            return_value=db,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        await dispatcher.dispatch(request, emitter=emitter)

    recovery_service.recover.assert_awaited_once()
    assert request.executor_name == "recovered-executor"
    assert request.executor_namespace == "default"
    dispatch_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_raises_when_recovery_returns_false_and_emits_error():
    """Dispatch should fail fast when executor recovery reports failure."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=2468,
        subtask_id=9753,
        message_id=7,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
        executor_name="deleted-executor",
    )
    emitter = AsyncMock()

    subtask = MagicMock(spec=Subtask)
    subtask.executor_deleted_at = True
    subtask.executor_name = "deleted-executor"
    subtask.executor_namespace = ""

    task = MagicMock(spec=TaskResource)
    task.id = 2468
    task.kind = "Task"

    subtask_query = MagicMock()
    subtask_query.filter.return_value = subtask_query
    subtask_query.first.return_value = subtask

    task_query = MagicMock()
    task_query.filter.return_value = task_query
    task_query.first.return_value = task

    db = MagicMock()

    def query_side_effect(model):
        if model == Subtask:
            return subtask_query
        if model == TaskResource:
            return task_query
        return MagicMock()

    db.query.side_effect = query_side_effect

    recovery_service = MagicMock()
    recovery_service.recover = AsyncMock(return_value=False)

    with (
        patch(
            "app.services.execution.dispatcher.SessionLocal",
            return_value=db,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        with pytest.raises(RuntimeError, match="Failed to recover executor"):
            await dispatcher.dispatch(request, emitter=emitter)

    recovery_service.recover.assert_awaited_once()
    dispatch_mock.assert_not_awaited()
    emitter.emit_error.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatch_skips_recovery_for_chat_shell():
    """Recovery should not run for non-local executor shell types."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1385,
        subtask_id=1861,
        message_id=3,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "Chat"}],
        executor_name="existing-executor",
    )
    emitter = AsyncMock()

    recovery_service = MagicMock()
    recovery_service.recover = AsyncMock()

    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    with (
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        await dispatcher.dispatch(request, emitter=emitter)

    recovery_service.recover.assert_not_awaited()
    dispatch_mock.assert_awaited_once()
