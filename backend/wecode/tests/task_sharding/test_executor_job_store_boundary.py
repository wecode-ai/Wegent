from datetime import datetime, timedelta

import pytest

import app.services.adapters.executor_job as executor_job_module
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_task_id,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_store import ShardedTaskStore
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit

SEQUENCE_BASE = 1 << 22


class RunSyncSession:
    def __init__(self, sync_db):
        self.sync_db = sync_db

    async def run_sync(self, fn):
        return fn(self.sync_db)


class ReusedSessionLocal:
    def __init__(self, sync_db):
        self.sync_db = sync_db

    def __call__(self):
        return self

    def query(self, *args, **kwargs):
        return self.sync_db.query(*args, **kwargs)

    def commit(self):
        self.sync_db.commit()
        self.sync_db.expire_all()

    def rollback(self):
        self.sync_db.rollback()

    def close(self):
        pass


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        task_id_value = encode_user_scoped_id(uid or SHARD_COUNT, SEQUENCE_BASE + uid)
        subtask_model_for_task_id(task_id_value).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id((user_id & 0xFFFF) or SHARD_COUNT, sequence)


def new_subtask_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id((user_id & 0xFFFF) or SHARD_COUNT, sequence)


def task_payload(name: str) -> dict:
    now = datetime.now().isoformat()
    return {
        "kind": "Task",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {
            "name": name,
            "namespace": "default",
            "labels": {"taskType": "chat"},
        },
        "spec": {
            "title": name,
            "prompt": "run",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {
            "status": "COMPLETED",
            "progress": 100,
            "createdAt": now,
            "updatedAt": now,
        },
    }


def add_shard_task(test_db, *, user_id: int, sequence: int):
    task_id_value = new_task_id(user_id, sequence)
    model = task_model_for_task_id(task_id_value)
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json=task_payload(f"task-{task_id_value}"),
        is_active=TaskResource.STATE_ACTIVE,
        updated_at=datetime.now() - timedelta(hours=48),
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_shard_subtask(test_db, *, task, sequence: int):
    model = subtask_model_for_task_id(task.id)
    subtask = model(
        id=new_subtask_id(task.user_id, sequence),
        user_id=task.user_id,
        task_id=task.id,
        team_id=1,
        title="assistant",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
        executor_namespace="default",
        executor_name=f"executor-{task.id}",
        executor_deleted_at=False,
        created_at=datetime.now() - timedelta(hours=48),
        updated_at=datetime.now() - timedelta(hours=48),
        completed_at=datetime.now() - timedelta(hours=48),
    )
    test_db.add(subtask)
    test_db.flush()
    return subtask


def add_legacy_task_and_subtask(test_db):
    task = TaskResource(
        id=101,
        user_id=1,
        kind="Task",
        name="legacy-task",
        namespace="default",
        json=task_payload("legacy-task"),
        is_active=TaskResource.STATE_ACTIVE,
        updated_at=datetime.now() - timedelta(hours=48),
    )
    subtask = Subtask(
        id=102,
        user_id=1,
        task_id=101,
        team_id=1,
        title="assistant",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
        executor_namespace="default",
        executor_name="legacy-executor",
        executor_deleted_at=False,
        created_at=datetime.now() - timedelta(hours=48),
        updated_at=datetime.now() - timedelta(hours=48),
        completed_at=datetime.now() - timedelta(hours=48),
    )
    test_db.add_all([task, subtask])
    test_db.flush()
    return task, subtask


@pytest.mark.asyncio
async def test_executor_job_cleanup_uses_store_for_shard_and_legacy_rows(
    test_db, monkeypatch
):
    task_store = ShardedTaskStore()
    subtask_store = ShardedSubtaskStore()
    monkeypatch.setattr(executor_job_module.task_stores, "task_store", task_store)
    monkeypatch.setattr(executor_job_module.task_stores, "subtask_store", subtask_store)
    monkeypatch.setattr(
        executor_job_module,
        "SessionLocal",
        ReusedSessionLocal(test_db),
    )

    shard_task = add_shard_task(test_db, user_id=42, sequence=1)
    shard_subtask = add_shard_subtask(test_db, task=shard_task, sequence=2)
    legacy_task, legacy_subtask = add_legacy_task_and_subtask(test_db)

    service = executor_job_module.job_service
    async_db = RunSyncSession(test_db)
    cutoff = datetime.now() - timedelta(hours=24)

    runtime_subtasks = await service._list_runtime_cleanup_subtasks(async_db)
    assert {subtask.id for subtask in runtime_subtasks} >= {
        shard_subtask.id,
        legacy_subtask.id,
    }

    scanned = await service._scan_candidate_subtasks_batch(
        async_db,
        last_id=0,
        cutoff=cutoff,
        batch_size=10,
    )
    assert {subtask.id for subtask in scanned} >= {shard_subtask.id, legacy_subtask.id}

    task_map = await service._load_tasks_for_cleanup(
        async_db,
        task_ids=[shard_task.id, legacy_task.id],
    )
    assert set(task_map) == {shard_task.id, legacy_task.id}

    cleanup_subtasks = await service._get_cleanup_subtasks_for_task(
        async_db,
        shard_task.id,
    )
    assert [subtask.id for subtask in cleanup_subtasks] == [shard_subtask.id]

    await service._mark_executor_deleted([shard_subtask.id, legacy_subtask.id])

    assert (
        test_db.get(
            subtask_model_for_task_id(shard_task.id), shard_subtask.id
        ).executor_deleted_at
        is True
    )
    assert test_db.get(Subtask, legacy_subtask.id).executor_deleted_at is True
