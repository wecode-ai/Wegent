# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task run metric normalization and transaction publishing."""

from datetime import datetime
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.task_run_metric_hooks import TaskRunMetricHooks
from app.services.task_run_metrics import (
    TaskRunMetricEvent,
    failure_reason_id,
    normalize_failure_reason,
    task_run_failure_message,
)
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore


class _RecordingMetricsStore:
    def __init__(self) -> None:
        self.events: list[TaskRunMetricEvent] = []

    def record_events(self, events: Iterable[TaskRunMetricEvent]) -> None:
        self.events.extend(events)


def _create_task(test_db: Session, user: User) -> TaskResource:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name="metric-hooks",
        namespace="default",
        json={"spec": {"title": "Metric hooks"}},
    )
    test_db.add(task)
    test_db.flush()
    return task


def _new_subtask(task: TaskResource, status: SubtaskStatus) -> Subtask:
    return Subtask(
        user_id=task.user_id,
        task_id=task.id,
        team_id=1,
        title="Run",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=status,
        error_message="Executor failed for request 123456789",
        created_at=datetime.now(),
    )


def test_normalize_failure_reason_removes_volatile_identifiers() -> None:
    first = normalize_failure_reason(
        "Executor failed for 123456789 and " "550e8400-e29b-41d4-a716-446655440000"
    )
    second = normalize_failure_reason(
        "Executor  failed for 987654321 and " "123e4567-e89b-12d3-a456-426614174000"
    )

    assert first == "Executor failed for <number> and <uuid>"
    assert first == second
    assert failure_reason_id(first) == failure_reason_id(second)


def test_task_run_failure_message_extracts_terminal_jsonl_error() -> None:
    raw_message = "\n".join(
        [
            '{"type":"system","subtype":"hook_started"}',
            '{"type":"result","subtype":"success","is_error":true,'
            '"result":"API Error: 502 Bad Gateway"}',
        ]
    )

    assert (
        task_run_failure_message(raw_message, {"value": "partial output"})
        == "API Error: 502 Bad Gateway"
    )


def test_task_run_failure_message_uses_result_for_generic_wrapper() -> None:
    assert (
        task_run_failure_message(
            "Task failed with status: FAILED",
            {"error_type": "execution_error", "value": "Invalid model ID"},
        )
        == "Invalid model ID"
    )


def test_task_run_failure_message_keeps_specific_error_over_partial_result() -> None:
    assert (
        task_run_failure_message(
            "command timed out after 300s",
            {"error_type": "runtime_error", "value": "partial assistant output"},
        )
        == "command timed out after 300s"
    )


def test_transaction_hooks_publish_failure_and_retry_after_commit(
    test_db: Session, test_user: User
) -> None:
    store = _RecordingMetricsStore()
    hooks = TaskRunMetricHooks(test_db, store)  # type: ignore[arg-type]
    hooks.register()
    try:
        task = _create_task(test_db, test_user)
        subtask = _new_subtask(task, SubtaskStatus.FAILED)
        test_db.add(subtask)
        test_db.commit()

        assert len(store.events) == 1
        assert store.events[0].record_total is True
        assert store.events[0].sync_failure is True
        assert store.events[0].status == SubtaskStatus.FAILED

        subtask.status = SubtaskStatus.PENDING
        subtask.error_message = ""
        test_db.commit()

        assert len(store.events) == 2
        assert store.events[1].record_total is False
        assert store.events[1].sync_failure is True
        assert store.events[1].status == SubtaskStatus.PENDING
    finally:
        hooks.unregister()


def test_transaction_hooks_do_not_publish_rolled_back_events(
    test_db: Session, test_user: User
) -> None:
    store = _RecordingMetricsStore()
    hooks = TaskRunMetricHooks(test_db, store)  # type: ignore[arg-type]
    hooks.register()
    try:
        task = _create_task(test_db, test_user)
        test_db.add(_new_subtask(task, SubtaskStatus.FAILED))
        test_db.flush()
        test_db.rollback()

        assert store.events == []
    finally:
        hooks.unregister()


def test_bulk_status_update_queues_failure_removal_after_commit(
    test_db: Session, test_user: User
) -> None:
    metrics_store = _RecordingMetricsStore()
    hooks = TaskRunMetricHooks(test_db, metrics_store)  # type: ignore[arg-type]
    hooks.register()
    try:
        task = _create_task(test_db, test_user)
        test_db.add(_new_subtask(task, SubtaskStatus.FAILED))
        test_db.commit()

        subtask_store = SqlAlchemySubtaskStore()
        subtask_store.mark_task_messages_status(
            test_db,
            task_id=task.id,
            status=SubtaskStatus.DELETE,
        )
        test_db.commit()

        assert len(metrics_store.events) == 2
        assert metrics_store.events[1].record_total is False
        assert metrics_store.events[1].sync_failure is True
        assert metrics_store.events[1].status == SubtaskStatus.DELETE
    finally:
        hooks.unregister()
