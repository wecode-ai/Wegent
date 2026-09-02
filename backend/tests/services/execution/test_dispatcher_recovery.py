# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for executor recovery in the unified dispatch path."""

import asyncio
import threading
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.recovery_service import (
    ExecutorRecoveryContext,
    ExecutorRecoveryOutcome,
)
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import ExecutionRequest


def _fake_db_session(db):
    @contextmanager
    def session():
        yield db

    return session


def _recovery_context(
    *,
    task_id: int,
    subtask_id: int,
    executor_name: str | None,
    executor_namespace: str | None,
    executor_deleted_at: bool,
    archive_available: bool = False,
) -> ExecutorRecoveryContext:
    return ExecutorRecoveryContext(
        task_id=task_id,
        subtask_id=subtask_id,
        task_json={},
        previous_executor_name=executor_name,
        previous_executor_namespace=executor_namespace,
        executor_deleted_at=executor_deleted_at,
        archive_available=archive_available,
        archive_reason=None,
        prior_claude_session_evidence=False,
        subtask_error=None,
        task_error=None,
    )


async def _wait_for_thread(started: threading.Event) -> None:
    while not started.is_set():
        await asyncio.sleep(0)


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

    db = MagicMock()

    context = _recovery_context(
        task_id=1385,
        subtask_id=1861,
        executor_name="old-executor",
        executor_namespace="",
        executor_deleted_at=True,
    )

    async def recover_side_effect(*, context, request):
        request.executor_name = "recovered-executor"
        request.executor_namespace = "default"
        return ExecutorRecoveryOutcome(
            executor_name="recovered-executor",
            executor_namespace="default",
        )

    recovery_service = MagicMock()
    recovery_service.build_detached_context.return_value = context
    recovery_service.recover_detached = AsyncMock(side_effect=recover_side_effect)

    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    with (
        patch(
            "app.db.session.get_db_session",
            _fake_db_session(db),
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.subtask_store.get_by_id",
            return_value=subtask,
        ) as get_subtask_mock,
        patch(
            "app.services.execution.dispatcher.task_store.get_by_id",
            return_value=task,
        ) as get_task_mock,
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        await dispatcher.dispatch_worker_owned(request, emitter)

    recovery_service.recover_detached.assert_awaited_once_with(
        context=context,
        request=request,
    )
    assert get_subtask_mock.call_count == 2
    get_task_mock.assert_called_once_with(db, task_id=request.task_id)
    db.query.assert_not_called()
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

    db = MagicMock()
    task.json = {}
    context = _recovery_context(
        task_id=2468,
        subtask_id=9753,
        executor_name="deleted-executor",
        executor_namespace="",
        executor_deleted_at=True,
    )

    recovery_service = MagicMock()
    recovery_service.build_detached_context.return_value = context
    recovery_service.recover_detached = AsyncMock(
        return_value=ExecutorRecoveryOutcome()
    )

    with (
        patch(
            "app.db.session.get_db_session",
            _fake_db_session(db),
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.subtask_store.get_by_id",
            return_value=subtask,
        ) as get_subtask_mock,
        patch(
            "app.services.execution.dispatcher.task_store.get_by_id",
            return_value=task,
        ) as get_task_mock,
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        with pytest.raises(RuntimeError, match="Failed to recover executor"):
            await dispatcher.dispatch_worker_owned(request, emitter)

    recovery_service.recover_detached.assert_awaited_once_with(
        context=context,
        request=request,
    )
    get_subtask_mock.assert_called_once_with(db, subtask_id=request.subtask_id)
    get_task_mock.assert_called_once_with(db, task_id=request.task_id)
    db.query.assert_not_called()
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
    recovery_service.recover_detached = AsyncMock()

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
        await dispatcher.dispatch_worker_owned(request, emitter)

    recovery_service.recover_detached.assert_not_awaited()
    dispatch_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_does_not_scan_historical_deleted_subtasks():
    """Dispatch should only recover when the current subtask is marked deleted."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1385,
        subtask_id=1861,
        message_id=3,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
        executor_name="active-executor",
        executor_namespace="default",
    )
    emitter = AsyncMock()

    subtask = MagicMock(spec=Subtask)
    subtask.id = 1861
    subtask.executor_deleted_at = False
    subtask.executor_name = "active-executor"
    subtask.executor_namespace = "default"

    db = MagicMock()

    recovery_service = MagicMock()
    recovery_service.recover_detached = AsyncMock()

    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    with (
        patch(
            "app.db.session.get_db_session",
            _fake_db_session(db),
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.subtask_store.get_by_id",
            return_value=subtask,
        ) as get_subtask_mock,
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        await dispatcher.dispatch_worker_owned(request, emitter)

    recovery_service.recover_detached.assert_not_awaited()
    get_subtask_mock.assert_called_once_with(db, subtask_id=request.subtask_id)
    db.query.assert_not_called()
    dispatch_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_restores_fork_workspace_archive_before_first_run():
    """A forked task with workspace archive should restore it before dispatch."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1385,
        subtask_id=1861,
        message_id=3,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
        executor_name=None,
        fork_runtime={
            "workspaceArchive": {
                "sourceTaskId": 1,
                "storageKey": "workspace-archives/1/archive.tar.gz",
            }
        },
    )
    emitter = AsyncMock()

    subtask = MagicMock(spec=Subtask)
    subtask.id = 1861
    subtask.executor_deleted_at = False
    subtask.executor_name = None
    subtask.executor_namespace = None

    task = MagicMock(spec=TaskResource)
    task.id = 1385
    task.kind = "Task"

    db = MagicMock()
    context = _recovery_context(
        task_id=1385,
        subtask_id=1861,
        executor_name=None,
        executor_namespace=None,
        executor_deleted_at=False,
        archive_available=True,
    )

    recovery_service = MagicMock()
    recovery_service.build_detached_context.return_value = context
    recovery_service.recover_detached = AsyncMock(
        return_value=ExecutorRecoveryOutcome(
            executor_name="fork-restored-executor",
            executor_namespace="default",
        )
    )

    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    with (
        patch(
            "app.db.session.get_db_session",
            _fake_db_session(db),
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.subtask_store.get_by_id",
            return_value=subtask,
        ) as get_subtask_mock,
        patch(
            "app.services.execution.dispatcher.task_store.get_by_id",
            return_value=task,
        ) as get_task_mock,
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(
            dispatcher, "_dispatch_http_callback", AsyncMock()
        ) as dispatch_mock,
    ):
        await dispatcher.dispatch_worker_owned(request, emitter)

    recovery_service.recover_detached.assert_awaited_once_with(
        context=context,
        request=request,
    )
    assert get_subtask_mock.call_count == 2
    get_task_mock.assert_called_once_with(db, task_id=request.task_id)
    assert request.executor_name == "fork-restored-executor"
    assert request.executor_namespace == "default"
    dispatch_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_does_not_restore_fork_archive_for_device_target():
    """Device-targeted forks should let the local executor restore the archive."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1385,
        subtask_id=1861,
        message_id=3,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
        executor_name=None,
        fork_runtime={
            "workspaceArchive": {
                "sourceTaskId": 1,
                "storageKey": "workspace-archives/1/archive.tar.gz",
            }
        },
    )
    emitter = AsyncMock()

    recovery_service = MagicMock()
    recovery_service.recover_detached = AsyncMock()

    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        url="ws://device",
    )

    with (
        patch(
            "app.db.session.get_db_session",
            side_effect=AssertionError("device fork should not open recovery DB"),
        ),
        patch(
            "app.services.execution.dispatcher.recovery_service",
            recovery_service,
            create=True,
        ),
        patch(
            "app.services.execution.dispatcher.ensure_remote_control_enabled_for_device"
        ) as ensure_remote_control,
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(dispatcher, "_dispatch_websocket", AsyncMock()) as dispatch_mock,
    ):
        await dispatcher.dispatch(request, device_id="macbook", emitter=emitter)

    recovery_service.recover_detached.assert_not_awaited()
    ensure_remote_control.assert_called_once_with(user_id=7, device_id="macbook")
    dispatch_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_web_dispatch_never_runs_http_callback_or_error_projection_locally():
    """Worker IPC failures must not pull HTTP execution back into Web."""

    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=4321,
        subtask_id=9876,
        message_id=5,
        user={"id": 7, "name": "user7"},
        user_id=7,
        user_name="user7",
        bot=[{"shell_type": "ClaudeCode"}],
    )
    emitter = AsyncMock()
    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )
    worker_error = RuntimeError("worker unavailable")
    local_http_dispatch = AsyncMock()

    with (
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(
            dispatcher,
            "_dispatch_http_callback",
            local_http_dispatch,
        ),
        patch(
            "app.services.execution.stream_client." "stream_execution_client.dispatch",
            AsyncMock(side_effect=worker_error),
        ),
    ):
        with pytest.raises(RuntimeError, match="worker unavailable"):
            await dispatcher.dispatch(request, emitter=emitter)

    local_http_dispatch.assert_not_awaited()
    emitter.emit_error.assert_not_awaited()
    emitter.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_recovery_database_lookup_does_not_block_event_loop():
    """Slow recovery lookup must not monopolize the request event loop."""
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        bot=[{"shell_type": "ClaudeCode"}],
    )
    started = threading.Event()
    release = threading.Event()

    def blocking_load(_request):
        started.set()
        release.wait()
        return None

    safety_release = threading.Timer(2, release.set)
    safety_release.start()
    try:
        with patch.object(
            dispatcher,
            "_load_executor_recovery_context_sync",
            side_effect=blocking_load,
        ):
            recovery = asyncio.create_task(
                dispatcher._recover_executor_if_needed(request)
            )
            await asyncio.wait_for(_wait_for_thread(started), timeout=0.5)
            assert not recovery.done()
            release.set()
            await recovery
    finally:
        release.set()
        safety_release.cancel()
