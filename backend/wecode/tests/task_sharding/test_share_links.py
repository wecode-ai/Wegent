import importlib

import pytest
from fastapi import HTTPException

import app.stores.tasks as task_stores
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType, ShareLink
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.share import ShareLinkConfig
from app.services.share.task_share_service import task_share_service
from wecode.task_sharding.access_store import ShardedTaskAccessStore
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

SEQUENCE_BASE = 1 << 22


@pytest.fixture(scope="module", autouse=True)
def create_task_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        model = task_model_for_user(uid)
        model.__table__.create(bind=test_engine, checkfirst=True)


@pytest.fixture
def sharded_task_share_stores(monkeypatch):
    store = ShardedTaskStore()
    access_store = ShardedTaskAccessStore(task_store=store)

    task_share_module = importlib.import_module("app.services.share.task_share_service")
    monkeypatch.setattr(task_stores, "task_store", store)
    monkeypatch.setattr(task_stores, "task_access_store", access_store)
    monkeypatch.setattr(task_share_module.task_stores, "task_store", store)
    monkeypatch.setattr(
        task_share_module.task_stores, "task_access_store", access_store
    )


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def add_user(test_db, *, user_id: int, user_name: str):
    user = User(
        id=user_id,
        user_name=user_name,
        password_hash="test-password-hash",
        email=f"{user_name}@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.flush()
    return user


def task_payload(*, name: str, title: str = "Task title") -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "title": title,
            "prompt": "Prompt",
            "teamRef": {"name": "agent", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {"state": "Available", "status": "RUNNING"},
    }


def add_shard_task(test_db, *, task_id_value: int, user_id: int):
    model = task_model_for_task_id(task_id_value)
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json=task_payload(name=f"task-{task_id_value}"),
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


def test_owner_can_create_share_link_for_new_shard_task(
    test_db, sharded_task_share_stores
):
    owner_id = 101
    add_user(test_db, user_id=owner_id, user_name="share-owner-create")
    task_id_value = new_task_id(user_id=owner_id, sequence=1)
    add_shard_task(test_db, task_id_value=task_id_value, user_id=owner_id)

    response = task_share_service.create_share_link(
        test_db,
        resource_id=task_id_value,
        user_id=owner_id,
        config=ShareLinkConfig(require_approval=True),
    )

    saved_link = test_db.query(ShareLink).filter(ShareLink.id == response.id).one()
    assert response.resource_id == task_id_value
    assert saved_link.resource_id == task_id_value
    assert saved_link.resource_type == ResourceType.TASK.value


def test_get_share_link_reads_active_link_for_new_shard_task(
    test_db, sharded_task_share_stores
):
    owner_id = 102
    add_user(test_db, user_id=owner_id, user_name="share-owner-get")
    task_id_value = new_task_id(user_id=owner_id, sequence=2)
    add_shard_task(test_db, task_id_value=task_id_value, user_id=owner_id)
    created = task_share_service.create_share_link(
        test_db,
        resource_id=task_id_value,
        user_id=owner_id,
        config=ShareLinkConfig(require_approval=True),
    )

    fetched = task_share_service.get_share_link(
        test_db, resource_id=task_id_value, user_id=owner_id
    )

    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.resource_id == task_id_value


def test_get_share_info_resolves_token_and_loads_new_shard_task(
    test_db, sharded_task_share_stores
):
    owner_id = 103
    add_user(test_db, user_id=owner_id, user_name="share-owner-info")
    task_id_value = new_task_id(user_id=owner_id, sequence=3)
    task = add_shard_task(test_db, task_id_value=task_id_value, user_id=owner_id)
    created = task_share_service.create_share_link(
        test_db,
        resource_id=task_id_value,
        user_id=owner_id,
        config=ShareLinkConfig(require_approval=False),
    )

    info = task_share_service.get_share_info(test_db, created.share_token)

    assert info.resource_type == ResourceType.TASK.value
    assert info.resource_id == task_id_value
    assert info.resource_name == task.name
    assert info.owner_user_id == owner_id
    assert info.owner_user_name == "share-owner-info"


def test_resource_member_cannot_create_share_link_for_new_shard_task(
    test_db, sharded_task_share_stores
):
    owner_id = 104
    member_id = 105
    add_user(test_db, user_id=owner_id, user_name="share-owner-member")
    add_user(test_db, user_id=member_id, user_name="share-member")
    task_id_value = new_task_id(user_id=owner_id, sequence=4)
    add_shard_task(test_db, task_id_value=task_id_value, user_id=owner_id)
    add_resource_member(test_db, task_id_value=task_id_value, user_id=member_id)

    with pytest.raises(HTTPException) as exc_info:
        task_share_service.create_share_link(
            test_db,
            resource_id=task_id_value,
            user_id=member_id,
            config=ShareLinkConfig(require_approval=True),
        )

    assert exc_info.value.status_code == 403
