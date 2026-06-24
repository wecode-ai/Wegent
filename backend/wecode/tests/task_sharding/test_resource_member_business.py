import importlib

import pytest

import app.stores.tasks as task_stores
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.services.adapters.task_kinds.helpers import build_lite_task_list
from app.services.share.task_share_service import task_share_service
from app.services.task_member_service import task_member_service
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


def task_payload(
    *,
    name: str,
    title: str = "Task title",
    team_name: str = "agent",
    is_group_chat: bool = False,
    status: str = "RUNNING",
) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "title": title,
            "prompt": "Prompt",
            "teamRef": {"name": team_name, "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
            "is_group_chat": is_group_chat,
        },
        "status": {"state": "Available", "status": status},
    }


def add_shard_task(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
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
        json=payload or task_payload(name=f"task-{task_id_value}"),
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        is_group_chat=is_group_chat,
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
        role=ResourceRole.Maintainer.value,
        status=MemberStatus.APPROVED,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.flush()
    return member


def test_task_member_service_uses_access_store_for_member_and_group_chat(monkeypatch):
    class FakeAccessStore:
        def get_task(self, db, *, task_id: int):
            return None

        def get_task_owner_id(self, db, *, task_id: int):
            return None

        def is_task_owner(self, db, *, task_id: int, user_id: int):
            return False

        def is_member(self, db, *, task_id: int, user_id: int):
            return task_id == 123 and user_id == 456

        def is_group_chat(self, db, *, task_id: int):
            return task_id == 123

    task_member_module = importlib.import_module("app.services.task_member_service")

    monkeypatch.setattr(task_stores, "task_access_store", FakeAccessStore())
    monkeypatch.setattr(
        task_member_module.task_stores,
        "task_access_store",
        FakeAccessStore(),
    )

    assert task_member_service.is_member(None, 123, 456) is True
    assert task_member_service.is_group_chat(None, 123) is True


def test_task_share_get_resource_uses_access_store_for_shard_member(
    test_db, monkeypatch
):
    task_id_value = new_task_id(user_id=31, sequence=1)
    task = add_shard_task(test_db, task_id_value=task_id_value, user_id=31)

    task_share_module = importlib.import_module("app.services.share.task_share_service")

    fake_task_store = type(
        "FakeTaskStore",
        (),
        {"get_regular_active_task": lambda self, db, task_id: task},
    )()
    fake_access_store = type(
        "FakeAccessStore",
        (),
        {
            "is_member": lambda self, db, task_id, user_id: (
                task_id == task_id_value and user_id == 32
            )
        },
    )()
    monkeypatch.setattr(task_stores, "task_store", fake_task_store)
    monkeypatch.setattr(task_stores, "task_access_store", fake_access_store)
    monkeypatch.setattr(task_share_module.task_stores, "task_store", fake_task_store)
    monkeypatch.setattr(
        task_share_module.task_stores,
        "task_access_store",
        fake_access_store,
    )

    assert task_share_service._get_resource(test_db, task_id_value, 32).id == task.id


def test_task_member_service_reads_shard_owner_member_and_group_chat(
    test_db, monkeypatch
):
    task_member_module = importlib.import_module("app.services.task_member_service")

    access_store = ShardedTaskAccessStore()
    monkeypatch.setattr(task_stores, "task_access_store", access_store)
    monkeypatch.setattr(
        task_member_module.task_stores, "task_access_store", access_store
    )

    task_id_value = new_task_id(user_id=41, sequence=2)
    add_shard_task(
        test_db,
        task_id_value=task_id_value,
        user_id=41,
        payload=task_payload(name=f"task-{task_id_value}", is_group_chat=False),
        is_group_chat=True,
    )
    add_resource_member(test_db, task_id_value=task_id_value, user_id=42)

    assert task_member_service.is_member(test_db, task_id_value, 41) is True
    assert task_member_service.is_member(test_db, task_id_value, 42) is True
    assert task_member_service.is_member(test_db, task_id_value, 43) is False
    assert task_member_service.is_group_chat(test_db, task_id_value) is True


def test_build_lite_task_list_reads_group_chat_from_shard_field(test_db, monkeypatch):
    helpers_module = importlib.import_module("app.services.adapters.task_kinds.helpers")
    monkeypatch.setattr(
        helpers_module.task_stores, "task_access_store", ShardedTaskAccessStore()
    )

    task_id_value = new_task_id(user_id=51, sequence=3)
    task = add_shard_task(
        test_db,
        task_id_value=task_id_value,
        user_id=51,
        payload=task_payload(name=f"task-{task_id_value}", is_group_chat=False),
        is_group_chat=True,
    )

    result = build_lite_task_list(test_db, [task], user_id=51)

    assert result[0]["is_group_chat"] is True
