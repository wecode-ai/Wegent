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
    fail_stalled_subtask,
    list_stalled_candidates,
    sweep_stalled_subtasks,
)
from app.stores.tasks import subtask_store

NOW = datetime(2026, 10, 27, 15, 0, 0)


def _task(task_id: int, user_id: int = 7) -> TaskResource:
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
    executor_name: str = "wegent-task-example-abc",
) -> Subtask:
    return Subtask(
        id=subtask_id,
        task_id=task_id,
        user_id=7,
        team_id=1,
        title="assistant",
        role=role,
        status=status,
        progress=0,
        bot_ids=[1],
        executor_namespace="default",
        executor_name=executor_name,
        created_at=updated_at,
        updated_at=updated_at,
    )


def _candidate(**overrides) -> StalledCandidate:
    values = {
        "task_id": 100,
        "subtask_id": 200,
        "user_id": 7,
        "executor_name": "wegent-task-example-abc",
        "executor_namespace": "default",
        "updated_at": NOW - timedelta(minutes=30),
    }
    values.update(overrides)
    return StalledCandidate(**values)


def test_list_stalled_candidates_filters_running_and_old(test_db):
    """Only recent RUNNING assistant subtasks older than the cutoff are returned."""
    test_db.add(_task(100))
    test_db.add(_task(101))
    test_db.add(_task(102))
    test_db.add(_subtask(200, 100, status=SubtaskStatus.RUNNING))
    test_db.add(_subtask(201, 100, status=SubtaskStatus.COMPLETED))
    test_db.add(_subtask(202, 100, status=SubtaskStatus.RUNNING, role=SubtaskRole.USER))
    test_db.add(_subtask(203, 101, status=SubtaskStatus.RUNNING))
    test_db.add(
        _subtask(
            204,
            102,
            status=SubtaskStatus.RUNNING,
            updated_at=NOW - timedelta(days=30),
        )
    )
    test_db.commit()

    rows = list_stalled_candidates(
        test_db,
        cutoff=NOW - timedelta(minutes=15),
        max_age_cutoff=NOW - timedelta(days=7),
        limit=10,
    )

    assert [row.subtask_id for row in rows] == [200, 203]
    assert rows[0].user_id == 7


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
    """With heartbeat checks enabled, a silent live Pod is stalled."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900,
        heartbeat_timeout_seconds=1800,
        heartbeat_check_enabled=True,
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
async def test_classify_keeps_live_pod_when_heartbeat_check_disabled():
    """An absent heartbeat must not fail a task by default."""
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
        ) as heartbeat,
    ):
        reason = await sweeper.classify(_candidate(), now=NOW)

    assert reason is None
    heartbeat.assert_not_awaited()


@pytest.mark.asyncio
async def test_classify_keeps_live_pod_with_heartbeat():
    """A live Pod with a fresh heartbeat is healthy."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900,
        heartbeat_timeout_seconds=1800,
        heartbeat_check_enabled=True,
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
        silent_timeout_seconds=900,
        heartbeat_timeout_seconds=1800,
        heartbeat_check_enabled=True,
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
    with patch(
        "app.services.execution.stalled_tasks.executor_dispatch_pending",
        AsyncMock(return_value=False),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason == (EXECUTOR_NOT_STARTED_ERROR, "executor_not_started")


@pytest.mark.asyncio
async def test_classify_keeps_subtask_that_is_still_queued():
    """A RUNNING subtask waiting behind backpressure is not a failure."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with patch(
        "app.services.execution.stalled_tasks.executor_dispatch_pending",
        AsyncMock(return_value=True),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason is None


@pytest.mark.asyncio
async def test_classify_keeps_subtask_when_dispatch_state_is_unknown():
    """An unreachable queue probe must not fail a potentially queued task."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with patch(
        "app.services.execution.stalled_tasks.executor_dispatch_pending",
        AsyncMock(return_value=None),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason is None


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
            max_age_seconds=7 * 24 * 3600,
            heartbeat_timeout_seconds=1800,
            limit=10,
            now=NOW,
        )

    assert failed == [candidate.subtask_id]
    fail.assert_awaited_once()
    assert fail.await_args.kwargs["error_code"] == "executor_missing"


def test_update_fields_if_status_only_updates_running(test_db):
    """The conditional update loses the race once the status changed."""
    test_db.add(_task(300))
    test_db.add(_subtask(301, 300, status=SubtaskStatus.RUNNING))
    test_db.commit()
    subtask = test_db.get(Subtask, 301)

    changed = subtask_store.update_fields_if_status(
        test_db,
        subtask=subtask,
        from_status=SubtaskStatus.RUNNING,
        status=SubtaskStatus.FAILED,
        error_message="boom",
    )
    test_db.commit()

    assert changed is True
    test_db.expire_all()
    assert test_db.get(Subtask, 301).status == SubtaskStatus.FAILED
    assert (
        subtask_store.update_fields_if_status(
            test_db,
            subtask=subtask,
            from_status=SubtaskStatus.RUNNING,
            status=SubtaskStatus.FAILED,
            error_message="boom",
        )
        is False
    )


@pytest.mark.asyncio
async def test_fail_stalled_subtask_drops_event_when_status_changed():
    """A concurrent completion wins over the stale stall error."""
    emitter = MagicMock()
    emitter.emit = AsyncMock()
    emitter.close = AsyncMock()
    emitter.terminal_transition_lost = True

    with patch(
        "app.services.execution.stalled_tasks.StatusUpdatingEmitter",
        return_value=emitter,
    ):
        failed = await fail_stalled_subtask(
            _candidate(),
            error_message=EXECUTOR_MISSING_ERROR,
            error_code="executor_missing",
        )

    assert failed is False
