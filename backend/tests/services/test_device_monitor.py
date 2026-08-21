# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from app.services import device_monitor


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

    async def run_in_thread(function, *args):
        if function is device_monitor._list_running_device_subtasks:
            return [online, offline]
        if function is device_monitor._mark_subtasks_failed:
            assert args == ([offline],)
            return {offline.subtask_id}
        raise AssertionError(f"Unexpected worker function: {function}")

    with (
        patch.object(
            device_monitor.asyncio,
            "to_thread",
            new=AsyncMock(side_effect=run_in_thread),
        ) as to_thread,
        patch.object(
            device_monitor.device_service,
            "is_device_online",
            new=AsyncMock(side_effect=[True, False]),
        ) as is_device_online,
        patch.object(
            device_monitor.execution_dispatcher,
            "error",
            new=AsyncMock(),
        ) as emit_error,
    ):
        marked_count = await device_monitor.check_and_mark_failed_subtasks()

    assert marked_count == 1
    assert to_thread.await_args_list == [
        call(device_monitor._list_running_device_subtasks),
        call(device_monitor._mark_subtasks_failed, [offline]),
    ]
    assert is_device_online.await_args_list == [
        call(online.user_id, online.device_id),
        call(offline.user_id, offline.device_id),
    ]
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
