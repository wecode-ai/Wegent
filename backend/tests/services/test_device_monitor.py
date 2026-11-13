# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager, contextmanager
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services import device_monitor
from app.services.chat.storage import db as chat_db


@pytest.mark.asyncio
async def test_check_and_mark_failed_subtasks_offloads_database_work() -> None:
    online = device_monitor._RunningDeviceSubtask(
        subtask_id=1,
        task_id=10,
        message_id=100,
        user_id=1000,
        device_id="online",
    )
    offline = device_monitor._RunningDeviceSubtask(
        subtask_id=2,
        task_id=20,
        message_id=200,
        user_id=2000,
        device_id="offline",
    )

    with (
        patch.object(
            device_monitor.asyncio,
            "to_thread",
            new=AsyncMock(return_value=[online, offline]),
        ) as to_thread,
        patch.object(
            device_monitor.device_service,
            "is_device_online",
            new=AsyncMock(side_effect=[True, False]),
        ) as is_device_online,
        patch.object(
            device_monitor,
            "_emit_device_timeout",
            new=AsyncMock(return_value=True),
        ) as emit_error,
    ):
        marked_count = await device_monitor.check_and_mark_failed_subtasks()

    assert marked_count == 1
    to_thread.assert_awaited_once_with(device_monitor._list_running_device_subtasks)
    assert is_device_online.await_args_list == [
        call(online.user_id, online.device_id),
        call(offline.user_id, offline.device_id),
    ]
    emit_error.assert_awaited_once_with(offline)


@pytest.mark.asyncio
async def test_device_timeout_commits_both_statuses_and_ignores_stale_binding(
    test_db, test_user, monkeypatch
) -> None:
    owner = test_user.id
    task = TaskResource(
        user_id=owner,
        kind="Task",
        name="heartbeat",
        namespace="default",
        is_active=TaskResource.STATE_ACTIVE,
        json={
            "metadata": {"name": "heartbeat"},
            "spec": {
                "title": "Heartbeat",
                "prompt": "",
                "teamRef": {"name": "default"},
                "workspaceRef": {"name": "default"},
            },
            "status": {"status": "RUNNING"},
        },
    )
    test_db.add(task)
    test_db.flush()
    subtask = Subtask(
        user_id=owner,
        task_id=task.id,
        team_id=0,
        title="Heartbeat",
        bot_ids=[],
        status=SubtaskStatus.RUNNING,
        executor_name="device-current",
        executor_namespace=f"user-{owner}",
    )
    test_db.add(subtask)
    test_db.flush()

    @contextmanager
    def session():
        yield test_db
        test_db.flush()

    monkeypatch.setattr(chat_db, "_db_session", session)
    emit_error = AsyncMock()
    monkeypatch.setattr(
        device_monitor,
        "WebSocketResultEmitter",
        MagicMock(return_value=MagicMock(emit_error=emit_error, close=AsyncMock())),
    )
    with (
        patch(
            "app.services.execution.emitters.status_updating.collect_completed_result",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "app.services.chat.storage.session_manager.cleanup_streaming_state",
            new=AsyncMock(),
        ),
        patch.object(
            device_monitor.StatusUpdatingEmitter,
            "_publish_task_completed_event",
            new=AsyncMock(),
        ),
    ):
        stale = device_monitor._RunningDeviceSubtask(
            subtask.id, task.id, 1, owner, "old"
        )
        current = device_monitor._RunningDeviceSubtask(
            subtask.id, task.id, 1, owner, "current"
        )
        assert await device_monitor._emit_device_timeout(stale) is False
        assert subtask.status == SubtaskStatus.RUNNING
        assert task.json["status"]["status"] == "RUNNING"
        emit_error.assert_not_awaited()

        assert await device_monitor._emit_device_timeout(current) is True
        assert subtask.status == SubtaskStatus.FAILED
        assert task.json["status"]["status"] == "FAILED"
        assert await device_monitor._emit_device_timeout(current) is False
        emit_error.assert_awaited_once()


@pytest.mark.asyncio
async def test_monitor_uses_async_distributed_lock() -> None:
    lock_context_calls = []

    @asynccontextmanager
    async def lock_context(*args, **kwargs):
        lock_context_calls.append((args, kwargs))
        yield True

    async def stop_after_iteration(*args, **kwargs):
        device_monitor._monitor_running = False

    device_monitor._monitor_running = True
    try:
        with (
            patch.object(
                device_monitor.distributed_lock,
                "acquire_watchdog_context_async",
                new=MagicMock(side_effect=lock_context),
            ),
            patch.object(
                device_monitor,
                "check_and_mark_failed_subtasks",
                new=AsyncMock(),
            ) as check_subtasks,
            patch.object(
                device_monitor.asyncio,
                "sleep",
                new=AsyncMock(side_effect=stop_after_iteration),
            ),
        ):
            await device_monitor.monitor_device_heartbeat()
    finally:
        device_monitor._monitor_running = False

    assert lock_context_calls == [
        (
            ("device_heartbeat_monitor",),
            {
                "expire_seconds": device_monitor.LOCK_EXPIRE_SECONDS,
                "extend_interval_seconds": 10,
            },
        )
    ]
    check_subtasks.assert_awaited_once_with()
