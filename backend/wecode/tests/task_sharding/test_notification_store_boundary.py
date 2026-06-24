from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.notification import group_chat_summary as group_summary_module
from app.services.notification import unread_notification as unread_module
from app.services.notification.group_chat_summary import GroupChatSummaryService
from app.services.notification.unread_notification import UnreadNotificationService
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


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        subtask_model_for_task_id(new_task_id(uid, 0)).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


@pytest.fixture
def sharded_notification_stores(monkeypatch):
    stores = SimpleNamespace(
        task_store=ShardedTaskStore(),
        subtask_store=ShardedSubtaskStore(),
    )
    monkeypatch.setattr(group_summary_module, "task_stores", stores, raising=False)
    monkeypatch.setattr(unread_module, "task_stores", stores, raising=False)
    return stores


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def new_subtask_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def add_shard_task(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    title: str,
    is_group_chat: bool = True,
    updated_at: datetime | None = None,
):
    model = task_model_for_task_id(task_id_value)
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {"name": f"task-{task_id_value}", "namespace": "default"},
            "spec": {"title": title, "is_group_chat": is_group_chat},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        is_group_chat=is_group_chat,
    )
    if updated_at is not None:
        task.updated_at = updated_at
    test_db.add(task)
    test_db.flush()
    return task


def add_legacy_task(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    title: str,
    is_group_chat: bool = True,
):
    task = TaskResource(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"legacy-task-{task_id_value}",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {
                "name": f"legacy-task-{task_id_value}",
                "namespace": "default",
            },
            "spec": {"title": title, "is_group_chat": is_group_chat},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        is_group_chat=is_group_chat,
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_shard_subtask(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    subtask_id: int,
    message_id: int,
    role: SubtaskRole,
    created_at: datetime,
    sender_user_id: int = 0,
    prompt: str = "",
    result: dict | str | None = None,
):
    model = subtask_model_for_task_id(task_id_value)
    subtask = model(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title=f"message-{message_id}",
        bot_ids=[3],
        role=role,
        executor_namespace="",
        executor_name="",
        prompt=prompt,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=message_id,
        parent_id=max(message_id - 1, 0),
        error_message="",
        result=result,
        completed_at=created_at,
        created_at=created_at,
        sender_user_id=sender_user_id,
    )
    test_db.add(subtask)
    test_db.flush()
    return subtask


def add_user(test_db, *, user_id: int, user_name: str):
    user = User(
        id=user_id,
        user_name=user_name,
        email=f"{user_name}@example.com",
        password_hash="test",
    )
    test_db.add(user)
    test_db.flush()
    return user


def test_group_chat_summary_reads_specific_task_from_shard(
    test_db, sharded_notification_stores
):
    task_id_value = new_task_id(41, 1)
    add_shard_task(test_db, task_id_value=task_id_value, user_id=41, title="Shard 群")

    tasks = GroupChatSummaryService()._get_specific_group_chat_task(
        test_db, task_id_value
    )

    assert [task.id for task in tasks] == [task_id_value]


def test_group_chat_summary_reads_recent_group_chats_from_shard_and_legacy(
    test_db, sharded_notification_stores
):
    since = datetime.now() - timedelta(hours=1)
    shard_task_id = new_task_id(45, 1)
    old_shard_task_id = new_task_id(46, 1)
    personal_shard_task_id = new_task_id(47, 1)
    add_shard_task(
        test_db,
        task_id_value=shard_task_id,
        user_id=45,
        title="Shard recent",
        updated_at=since + timedelta(minutes=1),
    )
    add_shard_task(
        test_db,
        task_id_value=old_shard_task_id,
        user_id=46,
        title="Shard old",
        updated_at=since - timedelta(minutes=1),
    )
    add_shard_task(
        test_db,
        task_id_value=personal_shard_task_id,
        user_id=47,
        title="Shard personal",
        is_group_chat=False,
        updated_at=since + timedelta(minutes=2),
    )
    add_legacy_task(
        test_db,
        task_id_value=4501,
        user_id=45,
        title="Legacy recent",
    )

    tasks = GroupChatSummaryService()._get_recent_group_chat_tasks(test_db, since)

    assert {task.id for task in tasks} == {shard_task_id, 4501}


def test_group_chat_summary_reads_conversation_history_from_shard(
    test_db, sharded_notification_stores
):
    task_id_value = new_task_id(42, 1)
    since = datetime.now() - timedelta(hours=1)
    add_user(test_db, user_id=43, user_name="alice")
    add_shard_task(test_db, task_id_value=task_id_value, user_id=42, title="Shard 群")
    add_shard_subtask(
        test_db,
        task_id_value=task_id_value,
        user_id=42,
        subtask_id=new_subtask_id(42, 1),
        message_id=1,
        role=SubtaskRole.USER,
        created_at=since + timedelta(minutes=1),
        sender_user_id=43,
        prompt="hello",
    )
    add_shard_subtask(
        test_db,
        task_id_value=task_id_value,
        user_id=42,
        subtask_id=new_subtask_id(42, 2),
        message_id=2,
        role=SubtaskRole.ASSISTANT,
        created_at=since + timedelta(minutes=2),
        result={"value": "hi"},
    )

    conversation = GroupChatSummaryService()._get_conversation_history(
        test_db, task_id_value, since
    )

    assert conversation == [
        {"role": "user", "username": "alice", "content": "hello"},
        {"role": "assistant", "username": "AI", "content": "hi"},
    ]


def test_unread_notification_get_task_titles_reads_shard_and_legacy_tasks(
    test_db, sharded_notification_stores
):
    shard_task_id = new_task_id(44, 1)
    add_shard_task(
        test_db,
        task_id_value=shard_task_id,
        user_id=44,
        title="Shard title",
    )
    add_legacy_task(
        test_db,
        task_id_value=4401,
        user_id=44,
        title="Legacy title",
    )

    titles = UnreadNotificationService("redis://localhost")._get_task_titles(
        test_db, [shard_task_id, 4401]
    )

    assert titles == {
        shard_task_id: "Shard title",
        4401: "Legacy title",
    }
