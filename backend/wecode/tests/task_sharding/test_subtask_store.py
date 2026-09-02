from datetime import datetime, timedelta

import pytest

import app.services.subtask as subtask_service_module
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from shared.models.db.enums import ContextType
from wecode.task_sharding.access_store import ShardedTaskAccessStore
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_owner,
    subtask_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.store_registration import install_task_sharding_subtask_store
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_id import SLOT_COUNT
from wecode.task_sharding.task_store import ShardedTaskStore
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
    uid_from_id,
)

pytestmark = pytest.mark.unit

SEQUENCE_BASE = 1 << 22


class RecordingGlobalIdAllocator:
    """Allocator that returns IDs from a pre-configured list."""

    def __init__(self, subtask_ids: list[int]):
        self.subtask_ids = list(subtask_ids)
        self.calls = 0

    def allocate_task_id(self, user_id: int = 0) -> int:
        raise AssertionError("task id allocation not expected")

    def allocate_subtask_id(self, user_id: int = 0) -> int:
        self.calls += 1
        return self.subtask_ids.pop(0)


class UserScopedRecordingAllocator:
    """Allocator that encodes the requested user id into generated IDs."""

    def __init__(self):
        self.calls = 0
        self.user_ids: list[int] = []

    def allocate_task_id(self, user_id: int = 0) -> int:
        raise AssertionError("task id allocation not expected")

    def allocate_subtask_id(self, user_id: int = 0) -> int:
        self.calls += 1
        self.user_ids.append(user_id)
        uid = (user_id & 0xFFFF) or SHARD_COUNT
        return encode_user_scoped_id(uid, SEQUENCE_BASE + self.calls)


class StaticAccessStore:
    def __init__(self, is_member: bool):
        self._is_member = is_member

    def is_member(self, db, *, task_id: int, user_id: int) -> bool:
        return self._is_member


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        subtask_model_for_task_id(new_task_id(uid, 0)).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


@pytest.fixture
def fixed_clock():
    # No time-based ID generation in the new format; fixture kept for test signature compatibility.
    return None


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def count_legacy_subtasks(test_db) -> int:
    return test_db.query(Subtask).count()


def count_shard_subtasks(test_db, task_id_value: int) -> int:
    model = subtask_model_for_task_id(task_id_value)
    return test_db.query(model).filter(model.task_id == task_id_value).count()


def shard_subtask(
    *,
    task_id_value: int,
    user_id: int,
    sequence: int,
    message_id: int,
    role: SubtaskRole = SubtaskRole.USER,
    executor_namespace: str = "",
    executor_name: str = "",
    executor_deleted_at: bool = False,
    status: SubtaskStatus = SubtaskStatus.COMPLETED,
    sender_user_id: int = 0,
    prompt: str | None = None,
    error_message: str = "",
    result: dict | None = None,
    updated_at: datetime | None = None,
):
    model = subtask_model_for_task_id(task_id_value)
    now = datetime.now()
    return model(
        id=encode_user_scoped_id(
            uid_from_id(task_id_value), SEQUENCE_BASE + sequence + 1000
        ),
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title=f"message-{message_id}",
        bot_ids=[3],
        role=role,
        executor_namespace=executor_namespace,
        executor_name=executor_name,
        executor_deleted_at=executor_deleted_at,
        prompt=prompt if prompt is not None else f"prompt-{message_id}",
        status=status,
        progress=100,
        message_id=message_id,
        parent_id=max(message_id - 1, 0),
        error_message=error_message,
        result=result if result is not None else {"message": message_id},
        completed_at=now,
        created_at=now + timedelta(seconds=message_id),
        updated_at=updated_at,
        sender_user_id=sender_user_id,
    )


def legacy_subtask(
    *,
    subtask_id: int,
    task_id_value: int,
    user_id: int,
    message_id: int,
    role: SubtaskRole = SubtaskRole.USER,
    executor_namespace: str = "",
    executor_name: str = "",
    executor_deleted_at: bool = False,
    status: SubtaskStatus = SubtaskStatus.COMPLETED,
    prompt: str | None = None,
    error_message: str = "",
    result: dict | None = None,
    updated_at: datetime | None = None,
) -> Subtask:
    now = datetime.now()
    return Subtask(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title=f"legacy-message-{message_id}",
        bot_ids=[3],
        role=role,
        executor_namespace=executor_namespace,
        executor_name=executor_name,
        executor_deleted_at=executor_deleted_at,
        prompt=prompt if prompt is not None else f"legacy-prompt-{message_id}",
        status=status,
        progress=100,
        message_id=message_id,
        parent_id=max(message_id - 1, 0),
        error_message=error_message,
        result=result if result is not None else {"message": message_id},
        completed_at=now,
        created_at=now + timedelta(seconds=message_id),
        updated_at=updated_at,
    )


def add_migrated_legacy_task_and_subtask(
    test_db,
    *,
    task_id_value: int,
    subtask_id: int,
    owner_user_id: int,
):
    task_index = task_model_for_user(owner_user_id)(
        id=task_id_value,
        user_id=owner_user_id,
        kind="Task",
        name="migrated-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    from app.models.task import TaskResource

    legacy_task_index = TaskResource(
        id=task_id_value,
        user_id=owner_user_id,
        kind="Task",
        name="legacy-index-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    legacy_index = legacy_subtask(
        subtask_id=subtask_id,
        task_id_value=task_id_value,
        user_id=owner_user_id,
        message_id=1,
        prompt="legacy-index-prompt",
    )
    shard_model = subtask_model_for_owner(owner_user_id)
    now = datetime.now()
    shard_row = shard_model(
        id=subtask_id,
        user_id=owner_user_id,
        task_id=task_id_value,
        team_id=25,
        title="migrated-message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="migrated-shard-prompt",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"source": "shard"},
        completed_at=now,
        created_at=now,
    )
    test_db.add_all([legacy_task_index, task_index, legacy_index, shard_row])
    test_db.flush()
    return shard_row


def add_migrated_legacy_task(test_db, *, task_id_value: int, owner_user_id: int):
    from app.models.task import TaskResource

    legacy_task_index = TaskResource(
        id=task_id_value,
        user_id=owner_user_id,
        kind="Task",
        name="legacy-index-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    shard_task = task_model_for_user(owner_user_id)(
        id=task_id_value,
        user_id=owner_user_id,
        kind="Task",
        name="migrated-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    test_db.add_all([legacy_task_index, shard_task])
    test_db.flush()
    return shard_task


def test_get_by_id_reads_migrated_legacy_subtask_from_owner_shard(test_db):
    shard_row = add_migrated_legacy_task_and_subtask(
        test_db,
        task_id_value=701,
        subtask_id=1701,
        owner_user_id=71,
    )
    store = ShardedSubtaskStore()

    subtask = store.get_by_id(test_db, subtask_id=1701)

    assert subtask.id == shard_row.id
    assert subtask.prompt == "migrated-shard-prompt"


def test_list_by_task_reads_migrated_legacy_task_subtasks_from_owner_shard(test_db):
    add_migrated_legacy_task_and_subtask(
        test_db,
        task_id_value=702,
        subtask_id=1702,
        owner_user_id=72,
    )
    store = ShardedSubtaskStore()

    subtasks = store.list_by_task(
        test_db,
        task_id=702,
        user_id=72,
        access_store=StaticAccessStore(is_member=True),
    )

    assert [subtask.prompt for subtask in subtasks] == ["migrated-shard-prompt"]


def test_history_reads_migrated_legacy_task_subtasks_from_owner_shard(test_db):
    add_migrated_legacy_task_and_subtask(
        test_db,
        task_id_value=706,
        subtask_id=1706,
        owner_user_id=76,
    )
    shard_model = subtask_model_for_owner(76)
    now = datetime.now()
    new_follow_up = shard_model(
        id=encode_user_scoped_id(76, SEQUENCE_BASE + 1707),
        user_id=76,
        task_id=706,
        team_id=25,
        title="new-follow-up",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="new-follow-up",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=2,
        parent_id=1,
        error_message="",
        result={"source": "follow-up"},
        completed_at=now,
        created_at=now + timedelta(seconds=2),
    )
    test_db.add(new_follow_up)
    test_db.flush()
    store = ShardedSubtaskStore()

    ordered = store.list_by_task_ordered(
        test_db,
        task_id=706,
        owner_user_id=76,
    )
    unfiltered = store.list_by_task_unfiltered(
        test_db,
        task_id=706,
        owner_user_id=76,
    )

    assert [subtask.prompt for subtask in ordered] == [
        "migrated-shard-prompt",
        "new-follow-up",
    ]
    assert {subtask.prompt for subtask in unfiltered} == {
        "migrated-shard-prompt",
        "new-follow-up",
    }
    assert store.list_by_task_ordered(test_db, task_id=706, owner_user_id=77) == []


def test_create_user_subtask_for_migrated_legacy_task_writes_owner_shard(test_db):
    add_migrated_legacy_task(test_db, task_id_value=703, owner_user_id=73)
    subtask_id = encode_user_scoped_id(73, SEQUENCE_BASE + 703)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([subtask_id])
    )

    subtask = store.create_user_subtask(
        test_db,
        user_id=73,
        task_id=703,
        team_id=25,
        title="User message",
        bot_ids=[3],
        prompt="migrated task prompt",
        message_id=1,
        parent_id=0,
    )
    test_db.flush()

    shard_model = subtask_model_for_owner(73)
    assert subtask.id == subtask_id
    assert test_db.query(shard_model).filter(shard_model.id == subtask_id).count() == 1
    assert count_legacy_subtasks(test_db) == 0


def test_create_pair_for_migrated_legacy_task_writes_owner_shard(test_db):
    add_migrated_legacy_task(test_db, task_id_value=704, owner_user_id=74)
    user_subtask_id = encode_user_scoped_id(74, SEQUENCE_BASE + 704)
    assistant_subtask_id = encode_user_scoped_id(74, SEQUENCE_BASE + 705)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator(
            [user_subtask_id, assistant_subtask_id]
        )
    )

    user_subtask, assistant_subtask = store.create_user_and_assistant_subtasks(
        test_db,
        user_id=74,
        task_id=704,
        team_id=25,
        title="User message",
        assistant_title="Assistant message",
        bot_ids=[3],
        prompt="pair prompt",
        user_message_id=1,
        user_parent_id=0,
        assistant_message_id=2,
        assistant_parent_id=1,
    )
    test_db.flush()

    shard_model = subtask_model_for_owner(74)
    assert {user_subtask.id, assistant_subtask.id} == {
        user_subtask_id,
        assistant_subtask_id,
    }
    assert (
        test_db.query(shard_model)
        .filter(shard_model.id.in_([user_subtask_id, assistant_subtask_id]))
        .count()
        == 2
    )
    assert count_legacy_subtasks(test_db) == 0


def test_create_user_subtask_writes_new_task_subtask_to_shard_only(
    test_db, fixed_clock
):
    subtask_id = encode_user_scoped_id(17, SEQUENCE_BASE + 7)
    allocator = RecordingGlobalIdAllocator([subtask_id])
    task_id_value = new_task_id(17, 1)
    store = ShardedSubtaskStore(global_id_allocator=allocator)

    subtask = store.create_user_subtask(
        test_db,
        user_id=17,
        task_id=task_id_value,
        team_id=25,
        title="User message",
        bot_ids=[3],
        prompt="hello",
        message_id=1,
        parent_id=0,
        sender_user_id=18,
    )
    test_db.flush()

    assert allocator.calls == 1
    assert subtask.id == subtask_id
    assert count_shard_subtasks(test_db, task_id_value) == 1
    assert count_legacy_subtasks(test_db) == 0


def test_create_user_subtask_allocates_id_from_task_owner_route_when_sender_differs(
    test_db,
):
    allocator = UserScopedRecordingAllocator()
    task_id_value = new_task_id(41, 1)
    store = ShardedSubtaskStore(global_id_allocator=allocator)

    subtask = store.create_user_subtask(
        test_db,
        user_id=99,
        task_id=task_id_value,
        team_id=25,
        title="Group member message",
        bot_ids=[3],
        prompt="hello from member",
        message_id=1,
        parent_id=0,
        sender_user_id=99,
    )
    test_db.flush()

    loaded = store.get_basic_by_id(test_db, subtask_id=subtask.id)

    assert loaded is subtask
    assert allocator.user_ids == [uid_from_id(task_id_value)]
    assert count_shard_subtasks(test_db, task_id_value) == 1
    assert count_legacy_subtasks(test_db) == 0


def test_create_user_subtask_rejects_legacy_uuid_style_allocator_id(
    test_db, fixed_clock
):
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([5310397443737613])
    )
    task_id_value = new_task_id(1, 1)

    with pytest.raises(RuntimeError):
        store.create_user_subtask(
            test_db,
            user_id=1,
            task_id=task_id_value,
            team_id=25,
            title="User message",
            bot_ids=[3],
            prompt="hello",
            message_id=1,
            parent_id=0,
        )

    assert count_legacy_subtasks(test_db) == 0


def test_create_assistant_subtask_writes_new_task_subtask_to_shard_only(
    test_db, fixed_clock
):
    task_id_value = new_task_id(18, 1)
    subtask_id = encode_user_scoped_id(18, SEQUENCE_BASE + 8)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([subtask_id])
    )

    subtask = store.create_assistant_subtask(
        test_db,
        user_id=18,
        task_id=task_id_value,
        team_id=25,
        title="Assistant response",
        bot_ids=[3],
        message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert subtask.id == subtask_id
    assert subtask.role == SubtaskRole.ASSISTANT
    assert count_shard_subtasks(test_db, task_id_value) == 1
    assert count_legacy_subtasks(test_db) == 0


def test_create_user_and_assistant_subtasks_allocates_pair_in_one_batch(
    test_db,
    fixed_clock,
):
    user_subtask_id = encode_user_scoped_id(18, SEQUENCE_BASE + 11)
    assistant_subtask_id = encode_user_scoped_id(18, SEQUENCE_BASE + 12)
    allocator = RecordingGlobalIdAllocator([user_subtask_id, assistant_subtask_id])
    task_id_value = new_task_id(18, 1)
    store = ShardedSubtaskStore(global_id_allocator=allocator)

    user_subtask, assistant_subtask = store.create_user_and_assistant_subtasks(
        test_db,
        user_id=18,
        task_id=task_id_value,
        team_id=25,
        title="User message",
        assistant_title="Assistant response",
        bot_ids=[3],
        prompt="hello",
        user_message_id=1,
        user_parent_id=0,
        assistant_message_id=2,
        assistant_parent_id=1,
        sender_user_id=19,
    )
    test_db.flush()

    assert allocator.calls == 2
    assert user_subtask.id == user_subtask_id
    assert assistant_subtask.id == assistant_subtask_id
    assert user_subtask.role == SubtaskRole.USER
    assert assistant_subtask.role == SubtaskRole.ASSISTANT
    assert count_shard_subtasks(test_db, task_id_value) == 2
    assert count_legacy_subtasks(test_db) == 0


def test_create_subtask_writes_new_task_subtask_to_shard_only(test_db, fixed_clock):
    task_id_value = new_task_id(19, 1)
    subtask_id = encode_user_scoped_id(19, SEQUENCE_BASE + 9)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([subtask_id])
    )

    subtask = store.create_subtask(
        test_db,
        user_id=19,
        task_id=task_id_value,
        team_id=25,
        title="Imported message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        prompt="imported",
        executor_namespace=None,
        executor_name=None,
        message_id=3,
        parent_id=None,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        result={"ok": True},
        error_message="",
    )
    test_db.flush()

    assert subtask.id == subtask_id
    assert count_shard_subtasks(test_db, task_id_value) == 1
    assert count_legacy_subtasks(test_db) == 0


def test_create_user_subtask_routes_legacy_task_id_to_legacy_table(test_db):
    store = ShardedSubtaskStore()

    subtask = store.create_user_subtask(
        test_db,
        user_id=21,
        task_id=123,
        team_id=25,
        title="User message",
        bot_ids=[3],
        prompt="legacy",
        message_id=1,
        parent_id=0,
    )
    test_db.flush()

    assert subtask.task_id == 123
    assert test_db.query(Subtask).filter(Subtask.id == subtask.id).count() == 1


def test_create_assistant_subtask_inherits_executor_from_same_shard_previous(
    test_db, fixed_clock
):
    task_id_value = new_task_id(22, 1)
    shard_model = subtask_model_for_task_id(task_id_value)
    previous_id = encode_user_scoped_id(22, SEQUENCE_BASE + 2)
    previous = shard_model(
        id=previous_id,
        user_id=22,
        task_id=task_id_value,
        team_id=25,
        title="Previous assistant response",
        bot_ids=[3],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="default",
        executor_name="executor-a",
        executor_deleted_at=True,
        prompt="",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"done": True},
        completed_at=datetime.now(),
    )
    test_db.add(previous)
    test_db.flush()
    subtask_id = encode_user_scoped_id(22, SEQUENCE_BASE + 3)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([subtask_id])
    )

    subtask = store.create_assistant_subtask(
        test_db,
        user_id=22,
        task_id=task_id_value,
        team_id=25,
        title="Assistant response",
        bot_ids=[3],
        message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert subtask.executor_namespace == "default"
    assert subtask.executor_name == "executor-a"
    assert subtask.executor_deleted_at is True


def test_create_assistant_subtask_consumes_task_executor_reference(
    test_db, fixed_clock
):
    user_id = 24
    task_id_value = new_task_id(user_id, 1)
    task_model = task_model_for_user(user_id)
    task = task_model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name="regenerated-task",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {
                "labels": {
                    "lastExecutorName": "executor-regenerate",
                    "lastExecutorNamespace": "wb-plat-ide",
                    "lastExecutorDeletedAt": "true",
                    "unrelated": "preserved",
                }
            },
        },
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    test_db.add(task)
    test_db.flush()
    subtask_id = encode_user_scoped_id(user_id, SEQUENCE_BASE + 24)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([subtask_id])
    )

    subtask = store.create_assistant_subtask(
        test_db,
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title="Assistant response",
        bot_ids=[3],
        message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert subtask.executor_namespace == "wb-plat-ide"
    assert subtask.executor_name == "executor-regenerate"
    assert subtask.executor_deleted_at is True
    assert task.json["metadata"]["labels"] == {"unrelated": "preserved"}


def test_create_assistant_subtask_consumes_executor_reference_for_migrated_legacy_task(
    test_db,
):
    user_id = 27
    task_id_value = 927
    shard_task = add_migrated_legacy_task(
        test_db, task_id_value=task_id_value, owner_user_id=user_id
    )
    shard_task.json = {
        "kind": "Task",
        "metadata": {
            "labels": {
                "lastExecutorName": "executor-migrated",
                "lastExecutorNamespace": "wb-plat-ide",
                "lastExecutorDeletedAt": "false",
                "unrelated": "preserved",
            }
        },
    }
    test_db.flush()
    subtask_id = encode_user_scoped_id(user_id, SEQUENCE_BASE + 27)
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([subtask_id])
    )

    subtask = store.create_assistant_subtask(
        test_db,
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title="Assistant response",
        bot_ids=[3],
        message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert subtask.__table__.name == subtask_model_for_owner(user_id).__table__.name
    assert subtask.executor_namespace == "wb-plat-ide"
    assert subtask.executor_name == "executor-migrated"
    assert subtask.executor_deleted_at is False
    assert shard_task.json["metadata"]["labels"] == {"unrelated": "preserved"}


def test_edit_user_message_preserves_latest_executor_for_sharded_task(
    test_db,
    monkeypatch,
):
    user_id = 26
    task_id_value = new_task_id(user_id, 1)
    task_model = task_model_for_user(user_id)
    task = task_model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name="regenerated-task",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {"labels": {"unrelated": "preserved"}},
            "spec": {"is_group_chat": False},
        },
        is_active=1,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    old_assistant = shard_subtask(
        task_id_value=task_id_value,
        user_id=user_id,
        sequence=1,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="wb-plat-ide",
        executor_name="executor-old",
    )
    edited_user = shard_subtask(
        task_id_value=task_id_value,
        user_id=user_id,
        sequence=2,
        message_id=3,
    )
    deleted_assistant = shard_subtask(
        task_id_value=task_id_value,
        user_id=user_id,
        sequence=3,
        message_id=4,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="wb-plat-ide",
        executor_name="executor-latest",
        executor_deleted_at=True,
    )
    test_db.add_all([task, old_assistant, edited_user, deleted_assistant])
    test_db.flush()
    next_subtask_id = encode_user_scoped_id(user_id, SEQUENCE_BASE + 26)
    task_store = ShardedTaskStore()
    subtask_store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([next_subtask_id])
    )
    access_store = ShardedTaskAccessStore(task_store=task_store)
    monkeypatch.setattr(subtask_service_module, "task_store", task_store)
    monkeypatch.setattr(subtask_service_module, "subtask_store", subtask_store)
    monkeypatch.setattr(subtask_service_module, "task_access_store", access_store)

    result = subtask_service_module.subtask_service.edit_user_message(
        test_db,
        subtask_id=edited_user.id,
        new_content="regenerate",
        user_id=user_id,
    )
    assistant = subtask_store.create_assistant_subtask(
        test_db,
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title="Assistant response",
        bot_ids=[3],
        message_id=4,
        parent_id=3,
    )
    test_db.flush()

    model = subtask_model_for_task_id(task_id_value)
    assert result == (edited_user.id, 3, 2)
    assert test_db.get(model, old_assistant.id) is old_assistant
    assert test_db.get(model, edited_user.id) is None
    assert test_db.get(model, deleted_assistant.id) is None
    assert assistant.executor_namespace == "wb-plat-ide"
    assert assistant.executor_name == "executor-latest"
    assert assistant.executor_deleted_at is True
    assert task.json["metadata"]["labels"] == {"unrelated": "preserved"}


def test_get_latest_assistant_executor_from_shard_deletion_range(test_db):
    user_id = 25
    task_id_value = new_task_id(user_id, 1)
    task_model = task_model_for_user(user_id)
    test_db.add(
        task_model(
            id=task_id_value,
            user_id=user_id,
            kind="Task",
            name="regenerated-task",
            namespace="default",
            json={"kind": "Task"},
            is_active=1,
            client_origin="frontend",
            project_id=0,
            is_group_chat=False,
        )
    )
    test_db.add_all(
        [
            shard_subtask(
                task_id_value=task_id_value,
                user_id=user_id,
                sequence=1,
                message_id=2,
                role=SubtaskRole.ASSISTANT,
                executor_namespace="wb-plat-ide",
                executor_name="executor-old",
            ),
            shard_subtask(
                task_id_value=task_id_value,
                user_id=user_id,
                sequence=2,
                message_id=4,
                role=SubtaskRole.ASSISTANT,
                executor_namespace="wb-plat-ide",
                executor_name="executor-new",
                executor_deleted_at=True,
            ),
        ]
    )
    test_db.flush()
    store = ShardedSubtaskStore()

    reference = store.get_latest_assistant_executor_from(
        test_db,
        task_id=task_id_value,
        from_message_id=3,
        owner_user_id=user_id,
    )

    assert reference is not None
    assert reference.namespace == "wb-plat-ide"
    assert reference.name == "executor-new"
    assert reference.deleted_at is True
    assert (
        store.get_latest_assistant_executor_from(
            test_db,
            task_id=task_id_value,
            from_message_id=3,
            owner_user_id=user_id + 1,
        )
        is None
    )


def test_global_allocator_retries_duplicate_subtask_id(test_db, fixed_clock):
    task_id_value = new_task_id(23, 1)
    shard_model = subtask_model_for_task_id(task_id_value)
    duplicate_id = encode_user_scoped_id(23, SEQUENCE_BASE + 4)
    next_id = encode_user_scoped_id(23, SEQUENCE_BASE + 5)
    test_db.add(
        shard_model(
            id=duplicate_id,
            user_id=23,
            task_id=task_id_value,
            team_id=25,
            title="Existing",
            bot_ids=[3],
            role=SubtaskRole.USER,
            prompt="existing",
            message_id=1,
            parent_id=0,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            completed_at=datetime.now(),
        )
    )
    test_db.flush()
    store = ShardedSubtaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([duplicate_id, next_id]),
    )

    subtask = store.create_user_subtask(
        test_db,
        user_id=23,
        task_id=task_id_value,
        team_id=25,
        title="User message",
        bot_ids=[3],
        prompt="after duplicate",
        message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert subtask.id != duplicate_id
    assert subtask.id == next_id
    assert count_shard_subtasks(test_db, task_id_value) == 2


def test_install_task_sharding_subtask_store_replaces_global_store(monkeypatch):
    import app.stores.tasks as task_stores

    original_store = task_stores.subtask_store
    monkeypatch.setattr(task_stores, "subtask_store", original_store, raising=False)

    store = install_task_sharding_subtask_store()

    assert isinstance(store, ShardedSubtaskStore)
    assert task_stores.subtask_store is store
    assert (
        not isinstance(original_store, SqlAlchemySubtaskStore)
        or original_store is not store
    )


def test_list_by_task_reads_new_shard_with_member_visibility(test_db):
    task_id_value = new_task_id(31, 1)
    store = ShardedSubtaskStore()
    first = shard_subtask(
        task_id_value=task_id_value,
        user_id=31,
        sequence=1,
        message_id=2,
    )
    second = shard_subtask(
        task_id_value=task_id_value,
        user_id=99,
        sequence=2,
        message_id=1,
    )
    third = shard_subtask(
        task_id_value=task_id_value,
        user_id=31,
        sequence=3,
        message_id=3,
    )
    test_db.add_all([first, second, third])
    test_db.flush()

    member_messages = store.list_by_task(
        test_db,
        task_id=task_id_value,
        user_id=50,
        access_store=StaticAccessStore(True),
    )
    non_member_messages = store.list_by_task(
        test_db,
        task_id=task_id_value,
        user_id=31,
        access_store=StaticAccessStore(False),
    )

    assert [subtask.id for subtask in member_messages] == [
        second.id,
        first.id,
        third.id,
    ]
    assert [subtask.id for subtask in non_member_messages] == [first.id, third.id]
    assert (
        store.count_by_task_for_user(
            test_db,
            task_id=task_id_value,
            user_id=50,
            access_store=StaticAccessStore(True),
        )
        == 3
    )
    assert (
        store.count_by_task_for_user(
            test_db,
            task_id=task_id_value,
            user_id=31,
            access_store=StaticAccessStore(False),
        )
        == 2
    )


def test_get_by_id_reads_new_shard_with_contexts(test_db):
    task_id_value = new_task_id(41, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=41,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.add(
        SubtaskContext(
            id=4101,
            subtask_id=subtask.id,
            user_id=41,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="knowledge",
            type_data={},
        )
    )
    test_db.flush()

    result = store.get_by_id(test_db, subtask_id=subtask.id, owner_user_id=41)

    assert result is subtask
    assert [context.id for context in result.contexts] == [4101]


def test_get_basic_by_id_reads_new_shard(test_db):
    task_id_value = new_task_id(42, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=42,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.flush()

    assert store.get_basic_by_id(test_db, subtask_id=subtask.id) is subtask


def test_get_by_id_and_role_filters_new_shard_role(test_db):
    task_id_value = new_task_id(43, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=43,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.flush()

    assert (
        store.get_by_id_and_role(
            test_db,
            subtask_id=subtask.id,
            role=SubtaskRole.ASSISTANT,
        )
        is None
    )
    assert (
        store.get_by_id_and_role(
            test_db,
            subtask_id=subtask.id,
            role=SubtaskRole.USER,
        )
        is subtask
    )


def test_list_by_ids_and_role_reads_legacy_and_multiple_shards(test_db):
    legacy = legacy_subtask(
        subtask_id=1801,
        task_id_value=801,
        user_id=81,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
    )
    first_task_id = new_task_id(82, 1)
    first = shard_subtask(
        task_id_value=first_task_id,
        user_id=82,
        sequence=2,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
    )
    second_task_id = new_task_id(83, 1)
    second = shard_subtask(
        task_id_value=second_task_id,
        user_id=83,
        sequence=2,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
    )
    excluded = shard_subtask(
        task_id_value=second_task_id,
        user_id=83,
        sequence=3,
        message_id=2,
        role=SubtaskRole.USER,
    )
    test_db.add_all([legacy, first, second, excluded])
    test_db.flush()

    subtasks = ShardedSubtaskStore().list_by_ids_and_role(
        test_db,
        subtask_ids=[legacy.id, first.id, second.id, excluded.id, first.id],
        role=SubtaskRole.ASSISTANT,
    )

    assert {subtask.id for subtask in subtasks} == {
        legacy.id,
        first.id,
        second.id,
    }


def test_list_assistant_by_task_reads_new_shard_only_assistant_messages(test_db):
    task_id_value = new_task_id(45, 1)
    store = ShardedSubtaskStore()
    user_message = shard_subtask(
        task_id_value=task_id_value,
        user_id=45,
        sequence=1,
        message_id=1,
        role=SubtaskRole.USER,
    )
    first_assistant = shard_subtask(
        task_id_value=task_id_value,
        user_id=45,
        sequence=2,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
    )
    second_assistant = shard_subtask(
        task_id_value=task_id_value,
        user_id=45,
        sequence=3,
        message_id=3,
        role=SubtaskRole.ASSISTANT,
    )
    test_db.add_all([user_message, second_assistant, first_assistant])
    test_db.flush()

    result = store.list_assistant_by_task(
        test_db,
        task_id=task_id_value,
        owner_user_id=45,
    )

    assert [subtask.id for subtask in result] == [
        first_assistant.id,
        second_assistant.id,
    ]
    assert all(subtask.role == SubtaskRole.ASSISTANT for subtask in result)


def test_get_by_id_owner_mismatch_returns_none_for_new_shard(test_db):
    task_id_value = new_task_id(44, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=44,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.flush()

    assert store.get_by_id(test_db, subtask_id=subtask.id, owner_user_id=45) is None
    assert (
        store.get_basic_by_id(test_db, subtask_id=subtask.id, owner_user_id=45) is None
    )


def test_get_by_id_rejects_same_slot_different_owner(test_db):
    task_id_value = new_task_id(1068, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=1068,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.flush()

    assert uid_from_id(task_id_value) % SLOT_COUNT == 44
    # user_id=1068 and user_id=44 differ, so owner check rejects uid=44.
    assert store.get_by_id(test_db, subtask_id=subtask.id, owner_user_id=44) is None
    assert (
        store.get_basic_by_id(test_db, subtask_id=subtask.id, owner_user_id=44) is None
    )


def test_get_accessible_by_id_reads_new_shard_by_owner_or_membership(test_db):
    task_id_value = new_task_id(46, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=46,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.add(
        SubtaskContext(
            id=4601,
            subtask_id=subtask.id,
            user_id=46,
            context_type=ContextType.ATTACHMENT.value,
            name="attachment.pdf",
            type_data={},
        )
    )
    test_db.flush()

    owner_result = store.get_accessible_by_id(
        test_db,
        subtask_id=subtask.id,
        user_id=46,
        access_store=StaticAccessStore(False),
    )
    member_result = store.get_accessible_by_id(
        test_db,
        subtask_id=subtask.id,
        user_id=99,
        access_store=StaticAccessStore(True),
    )
    non_member_result = store.get_accessible_by_id(
        test_db,
        subtask_id=subtask.id,
        user_id=99,
        access_store=StaticAccessStore(False),
    )

    assert owner_result is subtask
    assert [context.id for context in owner_result.contexts] == [4601]
    assert member_result is subtask
    assert [context.id for context in member_result.contexts] == [4601]
    assert non_member_result is None


def test_list_latest_and_new_messages_since_read_new_shard_with_contexts(test_db):
    task_id_value = new_task_id(32, 1)
    store = ShardedSubtaskStore()
    old = shard_subtask(
        task_id_value=task_id_value,
        user_id=32,
        sequence=1,
        message_id=1,
    )
    middle = shard_subtask(
        task_id_value=task_id_value,
        user_id=32,
        sequence=2,
        message_id=2,
        sender_user_id=320,
    )
    latest = shard_subtask(
        task_id_value=task_id_value,
        user_id=32,
        sequence=3,
        message_id=3,
    )
    test_db.add_all([old, middle, latest])
    test_db.add(
        SubtaskContext(
            id=3201,
            subtask_id=middle.id,
            user_id=32,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name="knowledge",
            type_data={},
        )
    )
    test_db.flush()

    latest_messages = store.list_latest_by_task(
        test_db,
        task_id=task_id_value,
        user_id=32,
        limit=2,
    )
    new_messages = store.list_new_messages_since(
        test_db,
        task_id=task_id_value,
        last_subtask_id=old.id,
        since=old.created_at,
    )

    assert [subtask.id for subtask in latest_messages] == [middle.id, latest.id]
    assert [subtask.id for subtask in new_messages] == [middle.id, latest.id]
    assert [context.id for context in new_messages[0].contexts] == [3201]


def test_get_next_message_id_reads_new_shard_and_owner_guard(test_db):
    task_id_value = new_task_id(33, 1)
    store = ShardedSubtaskStore()
    test_db.add_all(
        [
            shard_subtask(
                task_id_value=task_id_value,
                user_id=33,
                sequence=1,
                message_id=2,
            ),
            shard_subtask(
                task_id_value=task_id_value,
                user_id=33,
                sequence=2,
                message_id=7,
            ),
        ]
    )
    test_db.flush()

    assert store.get_next_message_id(test_db, task_id=task_id_value) == 8
    assert (
        store.get_next_message_id(
            test_db,
            task_id=task_id_value,
            owner_user_id=34,
        )
        == 1
    )


def test_get_next_message_id_reads_migrated_legacy_task_owner_shard(test_db):
    migrated = add_migrated_legacy_task_and_subtask(
        test_db,
        task_id_value=707,
        subtask_id=1707,
        owner_user_id=77,
    )
    shard_model = subtask_model_for_owner(77)
    latest = shard_model(
        id=encode_user_scoped_id(77, SEQUENCE_BASE + 2707),
        user_id=77,
        task_id=707,
        team_id=25,
        title="latest-follow-up",
        bot_ids=[3],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="latest-follow-up",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=8,
        parent_id=7,
        error_message="",
        result={"source": "follow-up"},
        completed_at=datetime.now(),
        created_at=migrated.created_at + timedelta(seconds=8),
    )
    test_db.add(latest)
    test_db.flush()
    store = ShardedSubtaskStore()

    assert store.get_next_message_id(test_db, task_id=707, owner_user_id=77) == 9
    assert [
        subtask.message_id
        for subtask in store.list_latest_by_task(
            test_db,
            task_id=707,
            user_id=77,
            limit=2,
        )
    ] == [1, 8]


def test_list_by_task_ordered_filters_new_shard_rows(test_db):
    task_id_value = new_task_id(34, 1)
    store = ShardedSubtaskStore()
    deleted = shard_subtask(
        task_id_value=task_id_value,
        user_id=34,
        sequence=1,
        message_id=3,
        status=SubtaskStatus.DELETE,
    )
    active = shard_subtask(
        task_id_value=task_id_value,
        user_id=34,
        sequence=2,
        message_id=2,
    )
    excluded = shard_subtask(
        task_id_value=task_id_value,
        user_id=34,
        sequence=3,
        message_id=1,
    )
    test_db.add_all([deleted, active, excluded])
    test_db.flush()

    assert (
        store.list_by_task_ordered(
            test_db,
            task_id=task_id_value,
            message_ids=[],
        )
        == []
    )
    subtasks = store.list_by_task_ordered(
        test_db,
        task_id=task_id_value,
        message_ids=[deleted.message_id, active.message_id, excluded.message_id],
        exclude_subtask_ids=[excluded.id],
        exclude_deleted=True,
        order_by="id",
    )

    assert [subtask.id for subtask in subtasks] == [active.id]
    assert (
        store.list_by_task_ordered(
            test_db,
            task_id=task_id_value,
            owner_user_id=35,
        )
        == []
    )


def test_runtime_lookup_methods_read_new_shard_rows(test_db):
    task_id_value = new_task_id(47, 1)
    store = ShardedSubtaskStore()
    first = shard_subtask(
        task_id_value=task_id_value,
        user_id=47,
        sequence=1,
        message_id=1,
        role=SubtaskRole.USER,
    )
    running = shard_subtask(
        task_id_value=task_id_value,
        user_id=47,
        sequence=2,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
        sender_user_id=470,
    )
    completed = shard_subtask(
        task_id_value=task_id_value,
        user_id=47,
        sequence=3,
        message_id=3,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
    )
    other_user = shard_subtask(
        task_id_value=task_id_value,
        user_id=48,
        sequence=4,
        message_id=4,
        role=SubtaskRole.USER,
    )
    test_db.add_all([completed, other_user, running, first])
    test_db.flush()

    assert store.get_first_by_task(test_db, task_id=task_id_value) is first
    assert (
        store.get_first_by_task(
            test_db,
            task_id=task_id_value,
            owner_user_id=48,
        )
        is None
    )
    assert (
        store.get_latest_assistant_for_user_by_statuses(
            test_db,
            task_id=task_id_value,
            user_id=47,
            statuses=[SubtaskStatus.RUNNING],
        )
        is running
    )
    assert [
        subtask.id
        for subtask in store.list_after_message_id(
            test_db,
            task_id=task_id_value,
            after_message_id=1,
        )
    ] == [running.id, completed.id, other_user.id]
    assert [
        subtask.id
        for subtask in store.list_by_task_for_user_ordered(
            test_db,
            task_id=task_id_value,
            user_id=47,
        )
    ] == [first.id, running.id, completed.id]


def test_uncovered_task_lookup_methods_read_new_shard_rows(test_db):
    task_id_value = new_task_id(48, 1)
    store = ShardedSubtaskStore()
    first_user = shard_subtask(
        task_id_value=task_id_value,
        user_id=48,
        sequence=1,
        message_id=1,
        role=SubtaskRole.USER,
    )
    running = shard_subtask(
        task_id_value=task_id_value,
        user_id=48,
        sequence=2,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
    )
    failed = shard_subtask(
        task_id_value=task_id_value,
        user_id=48,
        sequence=3,
        message_id=3,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.FAILED,
    )
    second_user = shard_subtask(
        task_id_value=task_id_value,
        user_id=48,
        sequence=4,
        message_id=4,
        role=SubtaskRole.USER,
    )
    deleted_executor = shard_subtask(
        task_id_value=task_id_value,
        user_id=48,
        sequence=5,
        message_id=5,
        role=SubtaskRole.ASSISTANT,
        executor_deleted_at=True,
        status=SubtaskStatus.COMPLETED,
    )
    test_db.add_all([first_user, running, failed, second_user, deleted_executor])
    test_db.flush()

    assert (
        store.get_running_assistant_for_user(
            test_db,
            task_id=task_id_value,
            user_id=48,
        )
        is running
    )
    assert (
        store.get_latest_assistant_by_statuses(
            test_db,
            task_id=task_id_value,
            statuses=[SubtaskStatus.RUNNING, SubtaskStatus.FAILED],
        )
        is failed
    )
    assert (
        store.get_retry_assistant(
            test_db,
            task_id=task_id_value,
            subtask_id=failed.id,
        )
        is failed
    )
    assert (
        store.get_user_by_task_message_id(
            test_db,
            task_id=task_id_value,
            message_id=4,
        )
        is second_user
    )
    assert (
        store.get_first_user_before_message_id(
            test_db,
            task_id=task_id_value,
            before_message_id=4,
        )
        is first_user
    )
    assert [
        subtask.id
        for subtask in store.list_completed_before_message_id(
            test_db,
            task_id=task_id_value,
            before_message_id=5,
        )
    ] == [first_user.id, second_user.id]
    assert store.get_latest_by_task(test_db, task_id=task_id_value) is deleted_executor
    assert [
        subtask.id
        for subtask in store.list_by_task_statuses(
            test_db,
            task_id=task_id_value,
            statuses=[SubtaskStatus.RUNNING, SubtaskStatus.FAILED],
        )
    ] == [running.id, failed.id]
    assert [
        subtask.id
        for subtask in store.list_not_executor_deleted_by_task(
            test_db,
            task_id=task_id_value,
        )
    ] == [first_user.id, running.id, failed.id, second_user.id]
    assert store.has_running_assistant(test_db, task_id=task_id_value) is True


def test_list_by_user_merges_legacy_and_user_shard_rows(test_db):
    store = ShardedSubtaskStore()
    user_id = 59
    legacy = legacy_subtask(
        subtask_id=5901,
        task_id_value=590,
        user_id=user_id,
        message_id=1,
    )
    first = shard_subtask(
        task_id_value=new_task_id(user_id, 1),
        user_id=user_id,
        sequence=1,
        message_id=1,
    )
    second = shard_subtask(
        task_id_value=new_task_id(user_id, 2),
        user_id=user_id,
        sequence=2,
        message_id=1,
    )
    other_user = shard_subtask(
        task_id_value=new_task_id(60, 1),
        user_id=60,
        sequence=1,
        message_id=1,
    )
    test_db.add_all([legacy, first, second, other_user])
    test_db.flush()

    subtasks = store.list_by_user(test_db, user_id=user_id, skip=1, limit=2)

    assert [subtask.id for subtask in subtasks] == [first.id, legacy.id]


def test_mark_task_subtasks_by_statuses_updates_new_shard_rows(test_db):
    task_id_value = new_task_id(49, 1)
    store = ShardedSubtaskStore()
    running = shard_subtask(
        task_id_value=task_id_value,
        user_id=49,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.RUNNING,
    )
    pending = shard_subtask(
        task_id_value=task_id_value,
        user_id=49,
        sequence=2,
        message_id=2,
        status=SubtaskStatus.PENDING,
    )
    completed = shard_subtask(
        task_id_value=task_id_value,
        user_id=49,
        sequence=3,
        message_id=3,
        status=SubtaskStatus.COMPLETED,
    )
    test_db.add_all([running, pending, completed])
    test_db.flush()
    completed_at = datetime(2026, 1, 2, 3, 4, 5)

    assert (
        store.mark_task_subtasks_by_statuses(
            test_db,
            task_id=task_id_value,
            from_statuses=[SubtaskStatus.RUNNING, SubtaskStatus.PENDING],
            to_status=SubtaskStatus.CANCELLED,
            progress=100,
            completed_at=completed_at,
            owner_user_id=50,
        )
        == 0
    )
    assert (
        store.mark_task_subtasks_by_statuses(
            test_db,
            task_id=task_id_value,
            from_statuses=[SubtaskStatus.RUNNING, SubtaskStatus.PENDING],
            to_status=SubtaskStatus.CANCELLED,
            progress=100,
            completed_at=completed_at,
        )
        == 2
    )
    test_db.flush()
    test_db.refresh(running)
    test_db.refresh(pending)
    test_db.refresh(completed)

    assert running.status == SubtaskStatus.CANCELLED
    assert pending.status == SubtaskStatus.CANCELLED
    assert completed.status == SubtaskStatus.COMPLETED
    assert running.progress == 100
    assert pending.completed_at == completed_at


def test_list_by_task_status_reads_new_shard(test_db):
    task_id_value = new_task_id(35, 1)
    store = ShardedSubtaskStore()
    pending = shard_subtask(
        task_id_value=task_id_value,
        user_id=35,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.PENDING,
    )
    running = shard_subtask(
        task_id_value=task_id_value,
        user_id=35,
        sequence=2,
        message_id=2,
        status=SubtaskStatus.RUNNING,
    )
    test_db.add_all([pending, running])
    test_db.flush()

    subtasks = store.list_by_task_status(
        test_db,
        task_id=task_id_value,
        status=SubtaskStatus.PENDING,
    )

    assert [subtask.id for subtask in subtasks] == [pending.id]


def test_list_history_by_task_statuses_reads_new_shard(test_db):
    task_id_value = new_task_id(36, 1)
    store = ShardedSubtaskStore()
    completed_early = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.COMPLETED,
    )
    running = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=2,
        message_id=2,
        status=SubtaskStatus.RUNNING,
    )
    completed_late = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=3,
        message_id=3,
        status=SubtaskStatus.COMPLETED,
    )
    after_cursor = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=4,
        message_id=4,
        status=SubtaskStatus.COMPLETED,
    )
    test_db.add_all([completed_late, running, after_cursor, completed_early])
    test_db.flush()

    subtasks = store.list_history_by_task_statuses(
        test_db,
        task_id=task_id_value,
        statuses=[SubtaskStatus.COMPLETED, SubtaskStatus.FAILED],
        before_message_id=4,
    )

    assert [subtask.id for subtask in subtasks] == [
        completed_early.id,
        completed_late.id,
    ]


def test_mark_task_status_methods_update_new_shard_rows(test_db):
    task_id_value = new_task_id(36, 1)
    store = ShardedSubtaskStore()
    first = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=1,
        message_id=1,
    )
    second = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=2,
        message_id=2,
    )
    test_db.add_all([first, second])
    test_db.flush()

    assert (
        store.mark_task_messages_status(
            test_db,
            task_id=task_id_value,
            status=SubtaskStatus.CANCELLED,
            owner_user_id=37,
        )
        == 0
    )
    assert (
        store.mark_task_messages_status(
            test_db,
            task_id=task_id_value,
            status=SubtaskStatus.CANCELLED,
        )
        == 2
    )
    test_db.flush()
    test_db.refresh(first)
    test_db.refresh(second)
    assert first.status == SubtaskStatus.CANCELLED
    assert second.status == SubtaskStatus.CANCELLED

    assert store.mark_task_subtasks_deleted(test_db, task_id=task_id_value) == 2
    test_db.flush()
    test_db.refresh(first)
    test_db.refresh(second)
    assert first.status == SubtaskStatus.DELETE
    assert second.status == SubtaskStatus.DELETE
    assert first.executor_deleted_at is True
    assert second.executor_deleted_at is True


def test_list_by_task_unfiltered_reads_new_shard_executor_refs(test_db):
    task_id_value = new_task_id(36, 10)
    store = ShardedSubtaskStore()
    user_subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=11,
        message_id=1,
    )
    assistant_subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=36,
        sequence=12,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="wegent-task-admin-test",
        status=SubtaskStatus.RUNNING,
    )
    test_db.add_all([user_subtask, assistant_subtask])
    test_db.flush()

    subtasks = store.list_by_task_unfiltered(
        test_db,
        task_id=task_id_value,
        owner_user_id=36,
    )

    assert {subtask.id for subtask in subtasks} == {
        user_subtask.id,
        assistant_subtask.id,
    }
    assert [subtask.executor_name for subtask in subtasks if subtask.executor_name] == [
        "wegent-task-admin-test"
    ]
    assert (
        store.list_by_task_unfiltered(
            test_db,
            task_id=task_id_value,
            owner_user_id=37,
        )
        == []
    )


def test_delete_message_range_deletes_new_shard_rows_and_cleans_contexts(test_db):
    task_id_value = new_task_id(37, 1)
    store = ShardedSubtaskStore()
    first = shard_subtask(
        task_id_value=task_id_value,
        user_id=37,
        sequence=1,
        message_id=1,
    )
    second = shard_subtask(
        task_id_value=task_id_value,
        user_id=37,
        sequence=2,
        message_id=2,
    )
    third = shard_subtask(
        task_id_value=task_id_value,
        user_id=37,
        sequence=3,
        message_id=3,
    )
    test_db.add_all([first, second, third])
    test_db.add_all(
        [
            SubtaskContext(
                id=3701,
                subtask_id=second.id,
                user_id=37,
                context_type=ContextType.ATTACHMENT.value,
                name="attachment.pdf",
                type_data={},
            ),
            SubtaskContext(
                id=3702,
                subtask_id=second.id,
                user_id=37,
                context_type=ContextType.KNOWLEDGE_BASE.value,
                name="knowledge",
                type_data={},
            ),
        ]
    )
    test_db.flush()

    assert (
        store.delete_after_message_id(
            test_db,
            task_id=task_id_value,
            after_message_id=2,
            owner_user_id=38,
        )
        == 0
    )
    assert (
        store.delete_after_message_id(
            test_db,
            task_id=task_id_value,
            after_message_id=2,
        )
        == 1
    )
    test_db.flush()
    assert (
        store.delete_from_message_id(
            test_db,
            task_id=task_id_value,
            from_message_id=2,
        )
        == 1
    )
    test_db.flush()

    model = subtask_model_for_task_id(task_id_value)
    assert test_db.get(model, first.id) is first
    assert test_db.get(model, second.id) is None
    assert test_db.get(model, third.id) is None
    attachment = test_db.get(SubtaskContext, 3701)
    assert attachment is not None
    assert attachment.subtask_id == 0
    assert test_db.get(SubtaskContext, 3702) is None


def test_delete_shard_subtask_cleans_contexts(test_db):
    task_id_value = new_task_id(38, 1)
    store = ShardedSubtaskStore()
    subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=38,
        sequence=1,
        message_id=1,
    )
    test_db.add(subtask)
    test_db.add_all(
        [
            SubtaskContext(
                id=3801,
                subtask_id=subtask.id,
                user_id=38,
                context_type=ContextType.ATTACHMENT.value,
                name="attachment.pdf",
                type_data={},
            ),
            SubtaskContext(
                id=3802,
                subtask_id=subtask.id,
                user_id=38,
                context_type=ContextType.KNOWLEDGE_BASE.value,
                name="knowledge",
                type_data={},
            ),
        ]
    )
    test_db.flush()

    store.delete(test_db, subtask=subtask)
    test_db.flush()

    model = subtask_model_for_task_id(task_id_value)
    assert test_db.get(model, subtask.id) is None
    attachment = test_db.get(SubtaskContext, 3801)
    assert attachment is not None
    assert attachment.subtask_id == 0
    assert test_db.get(SubtaskContext, 3802) is None


def test_list_recent_by_task_ids_merges_legacy_and_new_shards_with_global_limit(
    test_db,
):
    store = ShardedSubtaskStore()
    base_time = datetime(2026, 1, 1, 12, 0, 0)
    legacy_task_id = 501
    first_task_id = new_task_id(51, 1)
    second_task_id = new_task_id(52, 1)
    legacy = legacy_subtask(
        subtask_id=5011,
        task_id_value=legacy_task_id,
        user_id=51,
        message_id=1,
        updated_at=base_time + timedelta(seconds=30),
    )
    first_old = shard_subtask(
        task_id_value=first_task_id,
        user_id=51,
        sequence=1,
        message_id=1,
        updated_at=base_time + timedelta(seconds=10),
    )
    first_new = shard_subtask(
        task_id_value=first_task_id,
        user_id=51,
        sequence=2,
        message_id=2,
        updated_at=base_time + timedelta(seconds=40),
    )
    second = shard_subtask(
        task_id_value=second_task_id,
        user_id=52,
        sequence=1,
        message_id=1,
        updated_at=base_time + timedelta(seconds=20),
    )
    test_db.add_all([legacy, first_old, first_new, second])
    test_db.flush()

    subtasks = store.list_recent_by_task_ids(
        test_db,
        task_ids=[legacy_task_id, first_task_id, second_task_id],
        limit=3,
    )

    assert [subtask.id for subtask in subtasks] == [
        first_new.id,
        legacy.id,
        second.id,
    ]


def test_list_recent_by_task_ids_filters_new_shards_by_owner_user_id(test_db):
    store = ShardedSubtaskStore()
    base_time = datetime(2026, 1, 1, 12, 0, 0)
    owned_task_id = new_task_id(53, 1)
    other_task_id = new_task_id(54, 1)
    owned = shard_subtask(
        task_id_value=owned_task_id,
        user_id=53,
        sequence=1,
        message_id=1,
        updated_at=base_time,
    )
    other = shard_subtask(
        task_id_value=other_task_id,
        user_id=54,
        sequence=1,
        message_id=1,
        updated_at=base_time + timedelta(seconds=10),
    )
    test_db.add_all([owned, other])
    test_db.flush()

    subtasks = store.list_recent_by_task_ids(
        test_db,
        task_ids=[owned_task_id, other_task_id],
        owner_user_id=53,
        limit=10,
    )

    assert [subtask.id for subtask in subtasks] == [owned.id]


def test_search_task_ids_by_content_reads_legacy_and_new_shards(test_db):
    store = ShardedSubtaskStore()
    legacy_task_id = 601
    prompt_task_id = new_task_id(61, 1)
    error_task_id = new_task_id(62, 1)
    result_task_id = new_task_id(63, 1)
    missing_task_id = new_task_id(64, 1)
    test_db.add_all(
        [
            legacy_subtask(
                subtask_id=6011,
                task_id_value=legacy_task_id,
                user_id=61,
                message_id=1,
                prompt="legacy alpha hit",
            ),
            shard_subtask(
                task_id_value=prompt_task_id,
                user_id=61,
                sequence=1,
                message_id=1,
                prompt="new alpha prompt",
            ),
            shard_subtask(
                task_id_value=error_task_id,
                user_id=62,
                sequence=1,
                message_id=1,
                error_message="new alpha error",
            ),
            shard_subtask(
                task_id_value=result_task_id,
                user_id=63,
                sequence=1,
                message_id=1,
                result={"text": "new alpha result"},
            ),
            shard_subtask(
                task_id_value=missing_task_id,
                user_id=64,
                sequence=1,
                message_id=1,
                prompt="no match",
            ),
        ]
    )
    test_db.flush()

    task_ids = store.search_task_ids_by_content(
        test_db,
        task_ids=[
            legacy_task_id,
            prompt_task_id,
            error_task_id,
            result_task_id,
            missing_task_id,
        ],
        keyword="alpha",
    )

    assert task_ids == {
        legacy_task_id,
        prompt_task_id,
        error_task_id,
        result_task_id,
    }


def test_bulk_task_id_queries_return_empty_for_empty_task_ids(test_db):
    store = ShardedSubtaskStore()

    assert store.list_recent_by_task_ids(test_db, task_ids=[], limit=10) == []
    assert (
        store.search_task_ids_by_content(test_db, task_ids=[], keyword="alpha") == set()
    )


def test_background_scan_lists_merge_legacy_and_all_new_shards(test_db):
    store = ShardedSubtaskStore()
    legacy = legacy_subtask(
        subtask_id=7011,
        task_id_value=701,
        user_id=70,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="ns",
        executor_name="device-alpha",
        status=SubtaskStatus.RUNNING,
    )
    first_task_id = new_task_id(71, 1)
    second_task_id = new_task_id(72, 1)
    device = shard_subtask(
        task_id_value=first_task_id,
        user_id=71,
        sequence=1,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="ns",
        executor_name="device-alpha",
        status=SubtaskStatus.RUNNING,
    )
    named = shard_subtask(
        task_id_value=second_task_id,
        user_id=72,
        sequence=1,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="ns",
        executor_name="executor-beta",
        status=SubtaskStatus.RUNNING,
    )
    completed = shard_subtask(
        task_id_value=new_task_id(73, 1),
        user_id=73,
        sequence=1,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="ns",
        executor_name="device-alpha",
        status=SubtaskStatus.COMPLETED,
    )
    test_db.add_all([legacy, device, named, completed])
    test_db.flush()

    assert {subtask.id for subtask in store.list_running_device_subtasks(test_db)} == {
        legacy.id,
        device.id,
    }
    assert {
        subtask.id
        for subtask in store.list_running_by_executor_name(
            test_db,
            executor_name="device-alpha",
        )
    } == {legacy.id, device.id}
    assert {
        subtask.id
        for subtask in store.list_by_executor_ref(
            test_db,
            executor_namespace="ns",
            executor_name="device-alpha",
        )
    } == {legacy.id, device.id, completed.id}
    assert {subtask.id for subtask in store.list_running(test_db)} == {
        legacy.id,
        device.id,
        named.id,
    }


def test_list_running_since_merges_legacy_and_all_new_shards(test_db):
    store = ShardedSubtaskStore()
    created_after = datetime.now() - timedelta(minutes=5)
    legacy = legacy_subtask(
        subtask_id=7811,
        task_id_value=781,
        user_id=78,
        message_id=1,
        status=SubtaskStatus.RUNNING,
    )
    recent = shard_subtask(
        task_id_value=new_task_id(79, 1),
        user_id=79,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.RUNNING,
    )
    old = shard_subtask(
        task_id_value=new_task_id(80, 1),
        user_id=80,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.RUNNING,
    )
    old.created_at = created_after - timedelta(seconds=1)
    completed = shard_subtask(
        task_id_value=new_task_id(81, 1),
        user_id=81,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.COMPLETED,
    )
    test_db.add_all([legacy, recent, old, completed])
    test_db.flush()

    assert {
        subtask.id
        for subtask in store.list_running_since(
            test_db,
            created_after=created_after,
        )
    } == {legacy.id, recent.id}


def test_cleanup_cursor_references_merge_legacy_and_all_new_shards(test_db):
    store = ShardedSubtaskStore()
    threshold = datetime.now() - timedelta(days=7)
    legacy = legacy_subtask(
        subtask_id=7911,
        task_id_value=791,
        user_id=79,
        message_id=1,
    )
    legacy.created_at = threshold + timedelta(minutes=5)
    first_recent_task_id = new_task_id(80, 1)
    first_recent = shard_subtask(
        task_id_value=first_recent_task_id,
        user_id=80,
        sequence=1,
        message_id=1,
    )
    first_recent.created_at = threshold + timedelta(minutes=1)
    older_task_id = new_task_id(81, 1)
    older = shard_subtask(
        task_id_value=older_task_id,
        user_id=81,
        sequence=1,
        message_id=1,
    )
    older.created_at = threshold - timedelta(days=1)
    latest_task_id = new_task_id(82, 1)
    latest = shard_subtask(
        task_id_value=latest_task_id,
        user_id=82,
        sequence=10,
        message_id=1,
    )
    latest.created_at = threshold - timedelta(days=2)
    test_db.add_all([legacy, first_recent, older, latest])
    test_db.flush()

    recent_reference = store.get_cleanup_cursor_recent_start_reference(
        test_db,
        recent_threshold=threshold,
    )
    latest_reference = store.get_cleanup_cursor_latest_reference(test_db)

    assert recent_reference == first_recent
    assert latest_reference == latest


def test_list_session_task_ids_merges_deduplicates_sorts_and_pages(test_db):
    store = ShardedSubtaskStore()
    legacy_task_id = 801
    first_task_id = new_task_id(81, 1)
    second_task_id = new_task_id(82, 1)
    legacy = legacy_subtask(
        subtask_id=8011,
        task_id_value=legacy_task_id,
        user_id=80,
        message_id=1,
    )
    first_old = shard_subtask(
        task_id_value=first_task_id,
        user_id=81,
        sequence=1,
        message_id=1,
    )
    first_new = shard_subtask(
        task_id_value=first_task_id,
        user_id=81,
        sequence=3,
        message_id=2,
    )
    second = shard_subtask(
        task_id_value=second_task_id,
        user_id=82,
        sequence=2,
        message_id=1,
    )
    deleted = shard_subtask(
        task_id_value=new_task_id(83, 1),
        user_id=83,
        sequence=1,
        message_id=1,
        status=SubtaskStatus.DELETE,
    )
    test_db.add_all([legacy, first_old, first_new, second, deleted])
    test_db.flush()

    max_id_by_task_id = {
        legacy_task_id: legacy.id,
        first_task_id: max(first_old.id, first_new.id),
        second_task_id: second.id,
    }
    expected = [
        task_id_value
        for task_id_value, _ in sorted(
            max_id_by_task_id.items(),
            key=lambda item: item[1],
            reverse=True,
        )
    ]

    assert store.list_session_task_ids(test_db, skip=0, limit=10) == expected
    assert store.list_session_task_ids(test_db, skip=1, limit=1) == expected[1:2]


def test_mark_executor_deleted_updates_legacy_and_new_shards_by_executor_ref(test_db):
    store = ShardedSubtaskStore()
    legacy = legacy_subtask(
        subtask_id=9011,
        task_id_value=901,
        user_id=90,
        message_id=1,
        executor_namespace="ns",
        executor_name="executor-delete",
    )
    first = shard_subtask(
        task_id_value=new_task_id(91, 1),
        user_id=91,
        sequence=1,
        message_id=1,
        executor_namespace="ns",
        executor_name="executor-delete",
    )
    second = shard_subtask(
        task_id_value=new_task_id(92, 1),
        user_id=92,
        sequence=1,
        message_id=1,
        executor_namespace="ns",
        executor_name="executor-delete",
    )
    wrong_name = shard_subtask(
        task_id_value=new_task_id(93, 1),
        user_id=93,
        sequence=1,
        message_id=1,
        executor_namespace="ns",
        executor_name="executor-other",
    )
    wrong_namespace = shard_subtask(
        task_id_value=new_task_id(94, 1),
        user_id=94,
        sequence=1,
        message_id=1,
        executor_namespace="other",
        executor_name="executor-delete",
    )
    test_db.add_all([legacy, first, second, wrong_name, wrong_namespace])
    test_db.flush()

    assert (
        store.mark_executor_deleted(
            test_db,
            executor_namespace="ns",
            executor_name="executor-delete",
        )
        == 3
    )
    test_db.flush()
    for subtask in [legacy, first, second, wrong_name, wrong_namespace]:
        test_db.refresh(subtask)

    assert legacy.executor_deleted_at is True
    assert first.executor_deleted_at is True
    assert second.executor_deleted_at is True
    assert wrong_name.executor_deleted_at is False
    assert wrong_namespace.executor_deleted_at is False


def test_legacy_task_id_still_uses_base_methods(test_db, monkeypatch):
    store = ShardedSubtaskStore()
    calls = []

    def fake_next_message_id(self, db, *, task_id: int, owner_user_id=None):
        calls.append(("next", task_id, owner_user_id))
        return 42

    def fake_list_by_task_status(
        self,
        db,
        *,
        task_id: int,
        status,
        owner_user_id=None,
    ):
        calls.append(("status", task_id, status, owner_user_id))
        return ["legacy"]

    def fake_get_basic_by_id(self, db, *, subtask_id: int, owner_user_id=None):
        calls.append(("basic", subtask_id, owner_user_id))
        return "legacy-basic"

    monkeypatch.setattr(
        SqlAlchemySubtaskStore,
        "get_next_message_id",
        fake_next_message_id,
    )
    monkeypatch.setattr(
        SqlAlchemySubtaskStore,
        "list_by_task_status",
        fake_list_by_task_status,
    )
    monkeypatch.setattr(
        SqlAlchemySubtaskStore,
        "get_basic_by_id",
        fake_get_basic_by_id,
    )

    assert store.get_next_message_id(test_db, task_id=123, owner_user_id=1) == 42
    assert store.list_by_task_status(
        test_db,
        task_id=123,
        status=SubtaskStatus.PENDING,
        owner_user_id=1,
    ) == ["legacy"]
    assert (
        store.get_basic_by_id(test_db, subtask_id=123, owner_user_id=1)
        == "legacy-basic"
    )
    assert calls == [
        ("next", 123, 1),
        ("status", 123, SubtaskStatus.PENDING, 1),
        ("basic", 123, 1),
    ]
