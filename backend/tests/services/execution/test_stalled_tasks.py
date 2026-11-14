# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the stalled RUNNING subtask sweep."""

import asyncio
import logging
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.execution.stalled_task_cursor import (
    STALLED_TASK_CURSOR_KEY,
    StalledTaskCursor,
)
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


@pytest.fixture(autouse=True)
def execution_evidence_probe():
    with patch(
        "app.services.execution.stalled_tasks.has_execution_evidence",
        AsyncMock(return_value=False),
    ) as probe:
        yield probe


@pytest.fixture(autouse=True)
def scan_cursor_cache(monkeypatch):
    values = {}

    async def save(key, payload, *, expire):
        assert expire is None
        values[key] = payload
        return True

    cache = SimpleNamespace(
        get_or_raise=AsyncMock(side_effect=values.get),
        set_or_raise=AsyncMock(side_effect=save),
    )
    monkeypatch.setattr(
        "app.services.execution.stalled_task_cursor.cache_manager", cache
    )
    return values


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
    created_at: datetime | None = None,
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
        created_at=created_at or updated_at,
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
    test_db.add(
        _subtask(
            205,
            102,
            status=SubtaskStatus.RUNNING,
            created_at=NOW - timedelta(days=2),
            updated_at=NOW - timedelta(minutes=30),
        )
    )
    test_db.commit()

    rows = list_stalled_candidates(
        test_db,
        cutoff=NOW - timedelta(minutes=15),
        max_age_cutoff=NOW - timedelta(hours=24),
        limit=10,
    )

    assert [row.subtask_id for row in rows] == [200, 203]
    assert rows[0].user_id == 7


def test_existing_cursor_does_not_override_increased_silent_timeout(test_db):
    test_db.add(_task(100))
    test_db.add_all(
        [
            _subtask(
                200,
                100,
                status=SubtaskStatus.RUNNING,
                updated_at=NOW - timedelta(minutes=90),
            ),
            _subtask(201, 100, status=SubtaskStatus.RUNNING),
        ]
    )
    test_db.commit()
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=3600, heartbeat_timeout_seconds=1800
    )
    cursor = StalledTaskCursor(
        scan_cutoff=NOW - timedelta(minutes=15),
        updated_at=NOW - timedelta(hours=2),
        subtask_id=199,
    )

    rows = sweeper.candidates(
        test_db, now=NOW, max_age_seconds=86400, limit=50, cursor=cursor
    )

    assert [row.subtask_id for row in rows] == [200]


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
async def test_classify_fails_running_subtask_without_executor(
    execution_evidence_probe,
):
    """Keep the existing failure when no execution evidence is found."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with patch(
        "app.services.execution.stalled_tasks.executor_dispatch_pending",
        AsyncMock(return_value=False),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason == (EXECUTOR_NOT_STARTED_ERROR, "executor_not_started")
    execution_evidence_probe.assert_awaited_once_with(
        100, 200, since=NOW - timedelta(minutes=30)
    )


@pytest.mark.asyncio
async def test_classify_keeps_live_executor_without_bound_name(
    execution_evidence_probe,
):
    """A live task heartbeat proves dispatch started even before DB binding."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_dispatch_pending",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=True),
        ),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason is None
    execution_evidence_probe.assert_not_awaited()


@pytest.mark.asyncio
async def test_classify_without_executor_ignores_dead_or_unknown_heartbeat(
    execution_evidence_probe,
):
    """Only an explicit live heartbeat exempts an unbound subtask."""
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_dispatch_pending",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=False),
        ),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason == (EXECUTOR_NOT_STARTED_ERROR, "executor_not_started")
    execution_evidence_probe.assert_awaited_once_with(
        100, 200, since=NOW - timedelta(minutes=30)
    )


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
@pytest.mark.parametrize("evidence", [True, None])
async def test_classify_exempts_execution_evidence_or_unknown(
    execution_evidence_probe, caplog, evidence
):
    execution_evidence_probe.return_value = evidence
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_dispatch_pending",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=False),
        ),
        caplog.at_level(logging.INFO),
    ):
        reason = await sweeper.classify(_candidate(executor_name=""), now=NOW)

    assert reason is None
    expected_reason = "execution_evidence" if evidence else "execution_evidence_unknown"
    assert f"reason={expected_reason} " in caplog.text
    assert "task_id=100 subtask_id=200" in caplog.text
    assert "last_update=2026-10-27 14:30:00 cutoff=2026-10-27 14:30:00" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [TimeoutError(), RuntimeError("Redis unavailable")])
async def test_evidence_failure_does_not_interrupt_bound_executor_check(
    execution_evidence_probe, error
):
    execution_evidence_probe.side_effect = error
    candidates = [_candidate(executor_name=""), _candidate(subtask_id=201)]
    session = SimpleNamespace(run_sync=AsyncMock(return_value=candidates))
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_dispatch_pending",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=False),
        ),
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
            max_age_seconds=86400,
            limit=50,
            now=NOW,
        )

    assert failed == [201]
    fail.assert_awaited_once()
    assert fail.await_args.kwargs["error_code"] == "executor_missing"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fields", "pending"),
    [
        ({"executor_name": "device-example"}, False),
        ({"executor_name": "inprocess-chat"}, False),
        ({"executor_name": "inprocess_chat"}, False),
        ({"executor_namespace": "standalone"}, False),
        ({}, False),
        ({"executor_name": "", "updated_at": NOW}, False),
        ({"executor_name": ""}, True),
        ({"executor_name": ""}, None),
    ],
)
async def test_other_classification_branches_do_not_probe_evidence(
    execution_evidence_probe, fields, pending
):
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_dispatch_pending",
            AsyncMock(return_value=pending),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=False),
        ),
    ):
        assert await sweeper.classify(_candidate(**fields), now=NOW) is None

    execution_evidence_probe.assert_not_awaited()


@pytest.mark.asyncio
async def test_exempt_oldest_page_does_not_starve_later_executor(
    test_db, execution_evidence_probe, scan_cursor_cache
):
    test_db.add(_task(100))
    rows = [
        _subtask(
            subtask_id,
            100,
            status=SubtaskStatus.RUNNING,
            executor_name="" if subtask_id < 250 else "missing-executor",
        )
        for subtask_id in range(200, 251)
    ]
    test_db.add_all(rows)
    test_db.commit()
    execution_evidence_probe.return_value = True

    async def run_sync(fn):
        return fn(test_db)

    session = SimpleNamespace(run_sync=AsyncMock(side_effect=run_sync))
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_dispatch_pending",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_heartbeat_alive",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=True),
        ),
        patch(
            "app.services.execution.stalled_tasks.fail_stalled_subtask",
            AsyncMock(return_value=True),
        ) as fail,
    ):
        kwargs = dict(
            silent_timeout_seconds=900,
            heartbeat_timeout_seconds=1800,
            max_age_seconds=86400,
            limit=50,
            now=NOW,
        )
        assert await sweep_stalled_subtasks(session, **kwargs) == []
        assert execution_evidence_probe.await_count == 50
        fail.assert_not_awaited()
        assert scan_cursor_cache[STALLED_TASK_CURSOR_KEY]["subtask_id"] == 249
        # Removing an earlier row must not make pagination skip the next one.
        test_db.delete(rows[0])
        test_db.commit()
        assert await sweep_stalled_subtasks(session, **kwargs) == [250]
        rows[-1].status = SubtaskStatus.COMPLETED
        test_db.commit()
        # The cursor is now at the tail. The next sweep must wrap to the head.
        assert await sweep_stalled_subtasks(session, **kwargs) == []

    fail.assert_awaited_once()
    assert execution_evidence_probe.await_count == 99
    assert all(row.updated_at == NOW - timedelta(minutes=30) for row in rows[1:-1])


@pytest.mark.asyncio
async def test_new_candidates_do_not_prevent_rechecking_an_earlier_healthy_pod(
    test_db, scan_cursor_cache
):
    test_db.add(_task(100))
    test_db.add_all(
        [
            _subtask(
                200, 100, status=SubtaskStatus.RUNNING, executor_name="earlier-pod"
            ),
            _subtask(
                201,
                100,
                status=SubtaskStatus.RUNNING,
                updated_at=NOW - timedelta(minutes=20),
            ),
        ]
    )
    test_db.commit()

    async def run_sync(fn):
        return fn(test_db)

    session = SimpleNamespace(run_sync=AsyncMock(side_effect=run_sync))
    earlier_pod_missing = False
    checked_pods = []

    async def pod_missing(name, namespace):
        checked_pods.append(name)
        return name == "earlier-pod" and earlier_pod_missing

    kwargs = dict(
        silent_timeout_seconds=900,
        heartbeat_timeout_seconds=1800,
        max_age_seconds=86400,
        limit=1,
    )
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(side_effect=pod_missing),
        ),
        patch(
            "app.services.execution.stalled_tasks.fail_stalled_subtask",
            AsyncMock(return_value=True),
        ) as fail,
    ):
        assert await sweep_stalled_subtasks(session, now=NOW, **kwargs) == []
        first_cutoff = (NOW - timedelta(minutes=15)).isoformat()
        assert scan_cursor_cache[STALLED_TASK_CURSOR_KEY]["scan_cutoff"] == first_cutoff
        earlier_pod_missing = True
        # Newer rows become eligible every sweep, but belong to the next round.
        for subtask_id, elapsed_minutes in ((300, 10), (301, 20)):
            test_db.add(
                _subtask(
                    subtask_id,
                    100,
                    status=SubtaskStatus.RUNNING,
                    updated_at=NOW + timedelta(minutes=elapsed_minutes - 20),
                )
            )
            test_db.commit()
            failed = await sweep_stalled_subtasks(
                session, now=NOW + timedelta(minutes=elapsed_minutes), **kwargs
            )
            if subtask_id == 300:
                assert failed == []
                assert (
                    scan_cursor_cache[STALLED_TASK_CURSOR_KEY]["scan_cutoff"]
                    == first_cutoff
                )
            else:
                assert failed == [200]

    assert checked_pods == ["earlier-pod", "wegent-task-example-abc", "earlier-pod"]
    fail.assert_awaited_once()
    assert (
        scan_cursor_cache[STALLED_TASK_CURSOR_KEY]["scan_cutoff"]
        == (NOW + timedelta(minutes=5)).isoformat()
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["get_or_raise", "set_or_raise"])
async def test_cursor_redis_failure_does_not_stop_bound_executor_checks(
    monkeypatch, operation
):
    from app.services.execution import stalled_task_cursor

    monkeypatch.setattr(
        stalled_task_cursor.cache_manager,
        operation,
        AsyncMock(side_effect=TimeoutError()),
    )
    session = SimpleNamespace(run_sync=AsyncMock(return_value=[_candidate()]))
    with (
        patch(
            "app.services.execution.stalled_tasks.executor_pod_missing",
            AsyncMock(return_value=True),
        ),
        patch(
            "app.services.execution.stalled_tasks.fail_stalled_subtask",
            AsyncMock(return_value=True),
        ),
    ):
        failed = await sweep_stalled_subtasks(
            session,
            silent_timeout_seconds=900,
            heartbeat_timeout_seconds=1800,
            max_age_seconds=86400,
            limit=50,
            now=NOW,
        )

    assert failed == [200]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["get_or_raise", "set_or_raise"])
async def test_blocked_cursor_redis_operation_is_cancelled_and_sweep_continues(
    monkeypatch, operation
):
    from app.services.execution import stalled_task_cursor

    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def block(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(
        stalled_task_cursor, "STALLED_TASK_CURSOR_TIMEOUT_SECONDS", 0.01
    )
    monkeypatch.setattr(
        stalled_task_cursor.cache_manager,
        operation,
        AsyncMock(side_effect=block),
    )
    session = SimpleNamespace(run_sync=AsyncMock(return_value=[_candidate()]))
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
        failed = await asyncio.wait_for(
            sweep_stalled_subtasks(
                session,
                silent_timeout_seconds=900,
                heartbeat_timeout_seconds=1800,
                max_age_seconds=86400,
                limit=50,
                now=NOW,
            ),
            timeout=1,
        )

    assert started.is_set() and cancelled.is_set()
    assert failed == [200]
    fail.assert_awaited_once()


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
            max_age_seconds=24 * 3600,
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
