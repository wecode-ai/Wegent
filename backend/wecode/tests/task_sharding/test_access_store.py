import pytest

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from wecode.task_sharding.access_store import ShardedTaskAccessStore
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit

SEQUENCE_BASE = 1 << 22


@pytest.fixture(scope="module", autouse=True)
def create_task_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        model = task_model_for_user(uid)
        model.__table__.create(bind=test_engine, checkfirst=True)


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def add_shard_task(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    state: int = TaskResource.STATE_ACTIVE,
    payload: dict | None = None,
    is_group_chat: bool = False,
):
    model = task_model_for_task_id(task_id_value)
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json=payload or {"kind": "Task"},
        is_active=state,
        client_origin="frontend",
        is_group_chat=is_group_chat,
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_legacy_task(test_db, *, task_id_value: int, user_id: int):
    task = TaskResource(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json={"kind": "Task"},
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        is_group_chat=False,
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_resource_member(test_db, *, task_id_value: int, user_id: int):
    member = ResourceMember(
        resource_type=ResourceType.TASK,
        resource_id=task_id_value,
        entity_type="user",
        entity_id=str(user_id),
        user_id=user_id,
        role=ResourceRole.Reporter.value,
        status=MemberStatus.APPROVED,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.flush()
    return member


def test_get_task_owner_and_owner_check_read_new_shard_task(test_db):
    store = ShardedTaskAccessStore()
    task_id_value = new_task_id(user_id=17, sequence=1)
    task = add_shard_task(test_db, task_id_value=task_id_value, user_id=17)

    assert store.get_task(test_db, task_id=task_id_value).id == task.id
    assert store.get_task_owner_id(test_db, task_id=task_id_value) == 17
    assert store.is_task_owner(test_db, task_id=task_id_value, user_id=17) is True
    assert store.is_task_owner(test_db, task_id=task_id_value, user_id=18) is False


def test_get_task_keeps_legacy_fallback(test_db):
    store = ShardedTaskAccessStore()
    legacy_task = add_legacy_task(test_db, task_id_value=101, user_id=21)

    assert store.get_task(test_db, task_id=legacy_task.id).id == legacy_task.id
    assert store.get_task_owner_id(test_db, task_id=legacy_task.id) == 21


def test_is_member_accepts_new_shard_owner_and_resource_member(test_db):
    store = ShardedTaskAccessStore()
    task_id_value = new_task_id(user_id=22, sequence=2)
    add_shard_task(test_db, task_id_value=task_id_value, user_id=22)
    add_resource_member(test_db, task_id_value=task_id_value, user_id=23)

    assert store.is_member(test_db, task_id=task_id_value, user_id=22) is True
    assert store.is_member(test_db, task_id=task_id_value, user_id=23) is True
    assert store.is_member(test_db, task_id=task_id_value, user_id=24) is False


def test_runtime_state_reads_new_shard_task_for_owner_and_member(test_db):
    store = ShardedTaskAccessStore()
    task_id_value = new_task_id(user_id=29, sequence=6)
    add_shard_task(
        test_db,
        task_id_value=task_id_value,
        user_id=29,
        payload={
            "status": {
                "status": "RUNNING",
                "updatedAt": "2026-09-18T11:50:00",
            }
        },
    )
    add_resource_member(test_db, task_id_value=task_id_value, user_id=30)

    owner_state = store.get_runtime_state(test_db, task_id=task_id_value, user_id=29)
    member_state = store.get_runtime_state(test_db, task_id=task_id_value, user_id=30)

    assert owner_state is not None
    assert owner_state.status == "RUNNING"
    assert owner_state.updated_at == "2026-09-18T11:50:00"
    assert member_state is not None
    assert member_state.status == "RUNNING"
    assert store.get_runtime_state(test_db, task_id=task_id_value, user_id=31) is None


def test_is_group_chat_reads_field_and_json_spec_for_new_shard_task(test_db):
    store = ShardedTaskAccessStore()
    field_task_id = new_task_id(user_id=25, sequence=3)
    spec_task_id = new_task_id(user_id=26, sequence=4)
    add_shard_task(
        test_db,
        task_id_value=field_task_id,
        user_id=25,
        payload={"spec": {"is_group_chat": False}},
        is_group_chat=True,
    )
    add_shard_task(
        test_db,
        task_id_value=spec_task_id,
        user_id=26,
        payload={"spec": {"is_group_chat": True}},
        is_group_chat=False,
    )

    assert store.is_group_chat(test_db, task_id=field_task_id) is True
    assert store.is_group_chat(test_db, task_id=spec_task_id) is True


def test_list_member_task_ids_returns_new_task_id_from_resource_members(test_db):
    store = ShardedTaskAccessStore()
    task_id_value = new_task_id(user_id=27, sequence=5)
    add_resource_member(test_db, task_id_value=task_id_value, user_id=28)

    assert task_id_value in store.list_member_task_ids(test_db, user_id=28)


def test_install_task_sharding_access_store_replaces_global_store():
    import app.stores.tasks as task_stores
    from wecode.task_sharding.store_registration import (
        install_task_sharding_access_store,
    )

    original_store = task_stores.task_access_store
    try:
        installed = install_task_sharding_access_store()

        assert isinstance(installed, ShardedTaskAccessStore)
        assert isinstance(installed, SqlAlchemyTaskAccessStore)
        assert task_stores.task_access_store is installed
    finally:
        task_stores.task_access_store = original_store
