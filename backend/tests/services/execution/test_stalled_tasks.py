# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the stalled RUNNING subtask sweep."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.execution.stalled_tasks import (
    EXECUTOR_MISSING_ERROR,
    EXECUTOR_NOT_STARTED_ERROR,
    EXECUTOR_SILENT_ERROR,
    StalledCandidate,
    StalledSubtaskSweeper,
    list_stalled_candidates,
    sweep_stalled_subtasks,
)

NOW = datetime(2026, 10, 27, 15, 0, 0)


def _task(task_id: int, user_id: int = 508) -> TaskResource:
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={"status": {"state": "Available", "status": "RUNNING"}},
        is_active=TaskResource.STATE_ACTIVE,
    )


def _subtask(
    subtask_id: int,
    task_id: int,
    *,
    status: SubtaskStatus,
    role: SubtaskRole = SubtaskRole.ASSISTANT,
    updated_at: datetime = NOW - timedelta(minutes=30),
    executor_name: str = "wegent-task-xulu7-abc",
) -> Subtask:
    return Subtask(
        id=subtask_id,
        task_id=task_id,
        user_id=508,
        team_id=1,
        title="assistant",
        role=role,
        status=status,
        progress=0,
        bot_ids=[1],
        executor_namespace="wb-plat-ide",
        executor_name=executor_name,
        created_at=updated_at,
        updated_at=updated_at,
    )


def _candidate(**overrides) -> StalledCandidate:
    values = {
        "task_id": 100,
        "subtask_id": 200,
        "user_id": 508,
        "executor_name": "wegent-task-xulu7-abc",
        "executor_namespace": "wb-plat-ide",
        "updated_at": NOW - timedelta(minutes=30),
    }
    values.update(overrides)
    return StalledCandidate(**values)


def test_list_stalled_candidates_filters_running_and_old(test_db):
    """Only RUNNING assistant subtasks older than the cutoff are returned."""
    test_db.add(_task(100))
    test_db.add(_task(101))
    test_db.add(_subtask(200, 100, status=SubtaskStatus.RUNNING))
    test_db.add(_subtask(201, 100, status=SubtaskStatus.COMPLETED))
    test_db.add(_subtask(202, 100, status=SubtaskStatus.RUNNING, role=SubtaskRole.USER))
    test_db.add(_subtask(203, 101, status=SubtaskStatus.RUNNING))
    test_db.commit()

    rows = list_stalled_candidates(
        test_db,
        cutoff=NOW - timedelta(minutes=15),
        limit=10,
    )

    assert [row.subtask_id for row in rows] == [200, 203]
    assert rows[0].user_id == 508


@pytest.mark.asyncio
async def test_classify_fails_subtask_whose_executor_pod_is_gone():
    """A missing Pod is always a terminal condition."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with patch(
        "app.services.execution.stalled_tasks.executor_pod_missing",
        AsyncMock(return_value=True),
    ):
        reason = await sweeper.classify(_candidate(), now=NOW)

    assert reason == (EXECUTOR_MISSING_ERROR, "executor_missing")


@pytest.mark.asyncio
async def test_classify_ignores_device_executors():
    """Local device executors use their own liveness channel."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with patch(
        "app.services.execution.stalled_tasks.executor_pod_missing",
        AsyncMock(return_value=True),
    ) as pod_check:
        reason = await sweeper.classify(
            _candidate(executor_name="device-electron-1"), now=NOW
        )

    assert reason is None
    pod_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_classify_fails_live_pod_without_heartbeat():
    """A live Pod that stopped heartbeating for the heartbeat window is stalled."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=False),
        ),
    ):
        reason = await sweeper.classify(_candidate(), now=NOW)

    assert reason == (EXECUTOR_SILENT_ERROR, "executor_heartbeat_timeout")


@pytest.mark.asyncio
async def test_classify_keeps_live_pod_with_heartbeat():
    """A live Pod with a fresh heartbeat is healthy."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=True),
        ),
    ):
        reason = await sweeper.classify(_candidate(), now=NOW)

    assert reason is None


@pytest.mark.asyncio
async def test_classify_does_not_fail_on_unknown_heartbeat():
    """An unreachable heartbeat probe must not fail a running task."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=None),
        ),
    ):
        reason = await sweeper.classify(_candidate(), now=NOW)

    assert reason is None


@pytest.mark.asyncio
async def test_classify_fails_running_subtask_without_executor():
    """A RUNNING subtask without any executor never started."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason == (EXECUTOR_NOT_STARTED_ERROR, "executor_not_started")


@pytest.mark.asyncio
async def test_classify_ignores_inprocess_chat_executor():
    """In-process chat is not managed by executor_manager."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with patch(
        "app.services.execution.stalled_tasks.executor_pod_missing",
        AsyncMock(return_value=True),
    ) as pod_check:
        reason = await sweeper.classify(
            _candidate(executor_name="inprocess-chat"), now=NOW
        )

    assert reason is None
    pod_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_classify_keeps_recent_subtask_without_executor():
    """A subtask that only just started may not have an executor yet."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    candidate = _candidate(executor_name="", updated_at=NOW - timedelta(minutes=5))

    assert await sweeper.classify(candidate, now=NOW) is None


@pytest.mark.asyncio
async def test_sweep_fails_stalled_candidates():
    """The sweep reports only candidates classified as stalled."""
    candidate = _candidate()
    session = MagicMock()

    async def run_sync(fn):
        return [candidate]

    session.run_sync = AsyncMock(side_effect=run_sync)
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=True),
        ),
        patch(
            "app.services.execution.stalled_tasks.fail_stalled_subtask",
            AsyncMock(return_value=True),
        ) as fail,
    ):
        failed = await sweep_stalled_subtasks(
            session,
            silent_timeout_seconds=900,
            heartbeat_timeout_seconds=1800,
            limit=10,
            now=NOW,
        )

    assert failed == [candidate.subtask_id]
    fail.assert_awaited_once()
    assert fail.await_args.kwargs["error_code"] == "executor_missing"
