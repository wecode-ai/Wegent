from datetime import datetime
from typing import Iterable

import pytest
from sqlalchemy.orm import Session

from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.task_run_metrics import TaskRunMetricEvent
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_run_metric_hooks import ShardedTaskRunMetricHooks
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit

SEQUENCE_BASE = 1 << 22


class _RecordingMetricsStore:
    def __init__(self) -> None:
        self.events: list[TaskRunMetricEvent] = []

    def record_events(self, events: Iterable[TaskRunMetricEvent]) -> None:
        self.events.extend(events)


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine) -> None:
    for user_id in range(SHARD_COUNT):
        task_model_for_user(user_id).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )
        task_id = encode_user_scoped_id(user_id or SHARD_COUNT, SEQUENCE_BASE + 1)
        subtask_model_for_task_id(task_id).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


def _add_shard_run(
    db: Session,
    user: User,
    *,
    sequence: int,
    status: SubtaskStatus,
    title: str,
):
    task_id = encode_user_scoped_id(user.id, SEQUENCE_BASE + sequence)
    subtask_id = encode_user_scoped_id(user.id, SEQUENCE_BASE + sequence + 1000)
    task_model = task_model_for_user(user.id)
    subtask_model = subtask_model_for_task_id(task_id)
    now = datetime.now()
    task = task_model(
        id=task_id,
        user_id=user.id,
        kind="Task",
        name=f"metric-task-{sequence}",
        namespace="default",
        json={"spec": {"title": title}},
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    subtask = subtask_model(
        id=subtask_id,
        user_id=user.id,
        task_id=task_id,
        team_id=1,
        title="Run",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=status,
        progress=0,
        message_id=1,
        parent_id=0,
        error_message="Executor unavailable" if status == SubtaskStatus.FAILED else "",
        result=None,
        completed_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add_all([task, subtask])
    return task, subtask


def test_transaction_hooks_publish_sharded_assistant_changes(
    test_db: Session,
    test_user: User,
) -> None:
    metrics_store = _RecordingMetricsStore()
    hooks = ShardedTaskRunMetricHooks(
        test_db,
        metrics_store,  # type: ignore[arg-type]
    )
    hooks.register()
    try:
        _, subtask = _add_shard_run(
            test_db,
            test_user,
            sequence=10,
            status=SubtaskStatus.PENDING,
            title="Pending shard run",
        )
        test_db.commit()

        assert len(metrics_store.events) == 1
        assert metrics_store.events[0].subtask_id == subtask.id
        assert metrics_store.events[0].record_total is True
        assert metrics_store.events[0].sync_failure is False

        subtask.status = SubtaskStatus.FAILED
        subtask.error_message = "Executor unavailable"
        test_db.commit()

        assert len(metrics_store.events) == 2
        assert metrics_store.events[1].status == SubtaskStatus.FAILED
        assert metrics_store.events[1].record_total is False
        assert metrics_store.events[1].sync_failure is True
    finally:
        hooks.unregister()


def test_bulk_shard_status_update_queues_failure_removal(
    test_db: Session,
    test_user: User,
) -> None:
    task, subtask = _add_shard_run(
        test_db,
        test_user,
        sequence=20,
        status=SubtaskStatus.FAILED,
        title="Failed shard run",
    )
    test_db.commit()

    metrics_store = _RecordingMetricsStore()
    hooks = ShardedTaskRunMetricHooks(
        test_db,
        metrics_store,  # type: ignore[arg-type]
    )
    hooks.register()
    try:
        updated = ShardedSubtaskStore().mark_task_messages_status(
            test_db,
            task_id=task.id,
            status=SubtaskStatus.PENDING,
        )
        test_db.commit()

        assert updated == 1
        assert len(metrics_store.events) == 1
        assert metrics_store.events[0].subtask_id == subtask.id
        assert metrics_store.events[0].status == SubtaskStatus.PENDING
        assert metrics_store.events[0].sync_failure is True
    finally:
        hooks.unregister()


def test_sharded_store_loads_failure_details_in_requested_order(
    test_db: Session,
    test_user: User,
) -> None:
    _, first_failure = _add_shard_run(
        test_db,
        test_user,
        sequence=30,
        status=SubtaskStatus.FAILED,
        title="First shard failure",
    )
    _, latest_failure = _add_shard_run(
        test_db,
        test_user,
        sequence=40,
        status=SubtaskStatus.FAILED,
        title="Latest shard failure",
    )
    test_db.commit()

    details = ShardedSubtaskStore().list_failed_details_by_ids(
        test_db,
        subtask_ids=[latest_failure.id, first_failure.id],
        limit=1,
    )

    assert len(details) == 1
    assert details[0].subtask.id == latest_failure.id
    assert details[0].task.json["spec"]["title"] == "Latest shard failure"
    assert details[0].user_name == test_user.user_name
