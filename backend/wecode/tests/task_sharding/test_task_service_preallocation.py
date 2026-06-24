from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import converters, operations, task_kinds_service
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.task_store import ShardedTaskStore
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit


class RecordingGlobalIdAllocator:
    def __init__(self, task_ids: list[int]):
        self.task_ids = list(task_ids)
        self.task_calls = 0

    def allocate_task_id(self, user_id: int = 0) -> int:
        self.task_calls += 1
        return self.task_ids.pop(0)

    def allocate_subtask_id(self, user_id: int = 0) -> int:
        raise AssertionError("subtask id allocation is not expected")


@pytest.fixture(scope="module", autouse=True)
def create_task_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)


@pytest.fixture
def fixed_clock():
    return None


@pytest.fixture
def no_op_subtasks(monkeypatch):
    monkeypatch.setattr(operations, "create_subtasks", lambda *args, **kwargs: None)


@pytest.fixture
def sharded_task_store(monkeypatch, no_op_subtasks, test_user: User):
    # Pre-allocate two new-format IDs for the test_user
    ids = [encode_user_scoped_id(test_user.id & 0xFFFF, seq) for seq in [10, 11]]
    allocator = RecordingGlobalIdAllocator(task_ids=ids)
    store = ShardedTaskStore(global_id_allocator=allocator)
    monkeypatch.setattr(operations.task_stores, "task_store", store)
    monkeypatch.setattr(converters, "task_store", store)
    return store


def _create_team(db: Session, user_id: int) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name="agent",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "agent", "namespace": "default"},
            "spec": {
                "members": [],
                "collaborationModel": "coordinate",
                "description": "",
                "icon": "bot",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _create_legacy_placeholder(db: Session, user_id: int, task_id_value: int) -> None:
    db.add(
        TaskResource(
            id=task_id_value,
            user_id=user_id,
            kind="Placeholder",
            name=f"placeholder-{task_id_value}",
            namespace="default",
            json={"kind": "Placeholder"},
            is_active=TaskResource.STATE_DELETED,
            client_origin="frontend",
        )
    )
    db.flush()


def test_service_creates_task_for_internal_preallocated_id_from_sharded_placeholder(
    test_db: Session,
    test_user: User,
    fixed_clock,
    sharded_task_store: ShardedTaskStore,
):
    team = _create_team(test_db, test_user.id)
    preallocated_id = sharded_task_store.create_placeholder_task_id(
        test_db, user_id=test_user.id
    )

    result = task_kinds_service.create_task_or_append(
        test_db,
        obj_in=TaskCreate(
            team_id=team.id,
            title="Internal preallocated task",
            prompt="create without placeholder",
            task_type="task",
        ),
        user=test_user,
        task_id=preallocated_id,
    )

    model = task_model_for_task_id(preallocated_id)
    task = test_db.query(model).filter(model.id == preallocated_id).one()
    legacy_task = test_db.get(TaskResource, preallocated_id)
    assert result["id"] == preallocated_id
    assert legacy_task is None
    assert task.kind == "Task"
    assert task.user_id == test_user.id


def test_service_rejects_missing_legacy_task_id(
    test_db: Session,
    test_user: User,
    sharded_task_store: ShardedTaskStore,
):
    _create_team(test_db, test_user.id)

    with pytest.raises(HTTPException) as exc_info:
        task_kinds_service.create_task_or_append(
            test_db,
            obj_in=TaskCreate(
                team_name="agent",
                team_namespace="default",
                prompt="legacy missing",
                task_type="task",
            ),
            user=test_user,
            task_id=123456,
        )

    assert exc_info.value.status_code == 400


def test_service_rejects_internal_task_id_for_different_user(
    test_db: Session,
    test_user: User,
    fixed_clock,
    sharded_task_store: ShardedTaskStore,
):
    _create_team(test_db, test_user.id)
    other_user_task_id = encode_user_scoped_id((test_user.id + 1) & 0xFFFF, 12)

    with pytest.raises(HTTPException) as exc_info:
        task_kinds_service.create_task_or_append(
            test_db,
            obj_in=TaskCreate(
                team_name="agent",
                team_namespace="default",
                prompt="wrong uid",
                task_type="task",
            ),
            user=test_user,
            task_id=other_user_task_id,
        )

    assert exc_info.value.status_code == 400


def test_service_accepts_existing_legacy_placeholder(
    test_db: Session,
    test_user: User,
    no_op_subtasks,
):
    team = _create_team(test_db, test_user.id)
    task_id_value = 123457
    _create_legacy_placeholder(test_db, test_user.id, task_id_value)

    result = task_kinds_service.create_task_or_append(
        test_db,
        obj_in=TaskCreate(
            team_id=team.id,
            title="Legacy placeholder task",
            prompt="create with placeholder",
            task_type="task",
        ),
        user=test_user,
        task_id=task_id_value,
    )

    task = test_db.get(TaskResource, task_id_value)
    assert result["id"] == task_id_value
    assert task.kind == "Task"
    assert task.user_id == test_user.id
