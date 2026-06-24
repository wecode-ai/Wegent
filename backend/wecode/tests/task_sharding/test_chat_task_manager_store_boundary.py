from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.trigger.lifecycle import prepare_execution_session
from wecode.task_sharding.access_store import ShardedTaskAccessStore
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


class RecordingIdAllocator:
    """Allocates new-format IDs using encode_user_scoped_id and records call counts."""

    def __init__(self, start_seq: int = 1) -> None:
        self._seq = start_seq
        self.task_calls = 0
        self.subtask_calls = 0

    def allocate_task_id(self, user_id: int = 0) -> int:
        self.task_calls += 1
        seq = self._seq
        self._seq += 1
        return encode_user_scoped_id(user_id & 0xFFFF, seq)

    def allocate_subtask_id(self, user_id: int = 0) -> int:
        self.subtask_calls += 1
        seq = self._seq
        self._seq += 1
        return encode_user_scoped_id(user_id & 0xFFFF, seq)


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        task_id_value = encode_user_scoped_id(uid or SHARD_COUNT, SEQUENCE_BASE + uid)
        subtask_model_for_task_id(task_id_value).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


@pytest.fixture
def fixed_clock():
    return None


@pytest.fixture
def sharded_chat_stores(monkeypatch):
    task_allocator = RecordingIdAllocator(start_seq=1)
    subtask_allocator = RecordingIdAllocator(start_seq=100)
    task_store = ShardedTaskStore(global_id_allocator=task_allocator)
    subtask_store = ShardedSubtaskStore(global_id_allocator=subtask_allocator)
    access_store = ShardedTaskAccessStore(task_store=task_store)

    monkeypatch.setattr(task_stores, "task_store", task_store)
    monkeypatch.setattr(task_stores, "subtask_store", subtask_store)
    monkeypatch.setattr(task_stores, "task_access_store", access_store)
    return task_store, subtask_store, access_store


def _create_team_with_bot(db: Session, user_id: int) -> Kind:
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name="bot",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "ghost", "namespace": "default"},
                "shellRef": {"name": "shell", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
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
                "members": [{"botRef": {"name": "bot", "namespace": "default"}}],
                "collaborationModel": "coordinate",
                "description": "",
                "icon": "bot",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add_all([bot, team])
    db.flush()
    return team


def _completed_task_payload(task_id_value: int, team: Kind) -> dict:
    return {
        "kind": "Task",
        "spec": {
            "title": "Existing task",
            "prompt": "existing",
            "teamRef": {
                "name": team.name,
                "namespace": team.namespace,
                "user_id": team.user_id,
            },
            "workspaceRef": {
                "name": f"workspace-{task_id_value}",
                "namespace": "default",
            },
            "is_group_chat": False,
        },
        "status": {"state": "Available", "status": "COMPLETED"},
        "metadata": {
            "name": f"task-{task_id_value}",
            "namespace": "default",
            "labels": {"type": "online", "taskType": "chat"},
        },
        "apiVersion": "agent.wecode.io/v1",
    }


def test_prepare_execution_session_creates_task_workspace_and_subtasks_with_registered_stores(
    test_db: Session,
    test_user: User,
    fixed_clock,
    sharded_chat_stores,
):
    team = _create_team_with_bot(test_db, test_user.id)

    session = prepare_execution_session(
        db=test_db,
        user=test_user,
        team=team,
        input_text="hello",
        task_params=TaskCreationParams(message="hello"),
        should_trigger_ai=True,
    )

    task_model = task_model_for_task_id(session.task.id)
    subtask_model = subtask_model_for_task_id(session.task.id)
    assert (
        (session.task.id >> 37) & 0xFFFF
    ) == test_user.id & 0xFFFF  # uid embedded in new-format ID
    assert (
        test_db.query(task_model).filter(task_model.id == session.task.id).count() == 1
    )
    assert (
        test_db.query(task_model)
        .filter(task_model.kind == "Workspace", task_model.user_id == test_user.id)
        .count()
        == 1
    )
    assert (
        test_db.query(subtask_model)
        .filter(subtask_model.task_id == session.task.id)
        .count()
        == 2
    )
    assert test_db.query(TaskResource).count() == 0
    assert test_db.query(Subtask).count() == 0
    task_store, subtask_store, _ = sharded_chat_stores
    assert task_store.global_id_allocator.task_calls == 2


def test_adapter_task_creation_allocates_task_workspace_and_subtasks_in_pairs(
    test_db: Session,
    test_user: User,
    fixed_clock,
    sharded_chat_stores,
):
    team = _create_team_with_bot(test_db, test_user.id)

    result = task_kinds_service.create_task_or_append(
        test_db,
        obj_in=TaskCreate(
            team_id=team.id,
            title="Adapter paired create",
            prompt="adapter prompt",
            task_type="task",
            git_url="https://example.com/repo.git",
            git_repo="repo",
            git_repo_id=42,
            git_domain="example.com",
            branch_name="main",
        ),
        user=test_user,
    )

    task_model = task_model_for_task_id(result["id"])
    subtask_model = subtask_model_for_task_id(result["id"])
    assert test_db.query(task_model).filter(task_model.id == result["id"]).count() == 1
    assert (
        test_db.query(task_model)
        .filter(task_model.kind == "Workspace", task_model.user_id == test_user.id)
        .count()
        == 1
    )
    assert (
        test_db.query(subtask_model)
        .filter(subtask_model.task_id == result["id"])
        .count()
        == 2
    )
    assert test_db.query(TaskResource).count() == 0
    assert test_db.query(Subtask).count() == 0
    task_store, subtask_store, _ = sharded_chat_stores
    assert task_store.global_id_allocator.task_calls == 2


def test_prepare_execution_session_appends_to_registered_shard_task(
    test_db: Session,
    test_user: User,
    fixed_clock,
    sharded_chat_stores,
):
    task_store, subtask_store, _ = sharded_chat_stores
    team = _create_team_with_bot(test_db, test_user.id)
    task = task_store.create_pending_task_shell(
        test_db,
        user_id=test_user.id,
        client_origin="frontend",
    )
    task_store.update_fields(
        test_db,
        task=task,
        name=f"task-{task.id}",
        is_active=TaskResource.STATE_ACTIVE,
    )
    task_store.update_json(
        test_db,
        task=task,
        payload=_completed_task_payload(task.id, team),
    )
    existing = subtask_store.create_user_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task.id,
        team_id=team.id,
        title="User message",
        bot_ids=[1],
        prompt="first",
        message_id=1,
        parent_id=0,
    )
    test_db.commit()

    session = prepare_execution_session(
        db=test_db,
        user=test_user,
        team=team,
        input_text="second",
        task_params=TaskCreationParams(message="second"),
        task_id=task.id,
        should_trigger_ai=True,
    )

    subtask_model = subtask_model_for_task_id(task.id)
    messages = (
        test_db.query(subtask_model.message_id)
        .filter(subtask_model.task_id == task.id)
        .order_by(subtask_model.message_id)
        .all()
    )
    assert session.task.id == task.id
    assert [subtask.id for subtask in session.existing_subtasks] == [existing.id]
    assert [row[0] for row in messages] == [1, 2, 3]
    assert test_db.query(TaskResource).count() == 0
    assert test_db.query(Subtask).count() == 0
