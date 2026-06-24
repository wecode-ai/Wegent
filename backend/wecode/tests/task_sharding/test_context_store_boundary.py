from datetime import datetime

import pytest
from fastapi import HTTPException

import app.stores.tasks as task_stores
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.chat.preprocessing import contexts as contexts_module
from shared.models.db.subtask import Subtask
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
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
def sharded_context_store(monkeypatch):
    store = ShardedSubtaskStore()
    monkeypatch.setattr(task_stores, "subtask_store", store)
    monkeypatch.setattr(contexts_module.task_stores, "subtask_store", store)
    return store


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def new_subtask_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def shard_subtask(*, task_id_value: int, user_id: int, sequence: int):
    model = subtask_model_for_task_id(task_id_value)
    now = datetime.now()
    return model(
        id=new_subtask_id(user_id, sequence),
        user_id=user_id,
        task_id=task_id_value,
        team_id=25,
        title="message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="hello",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"ok": True},
        completed_at=now,
        created_at=now,
    )


def attachment_context(*, context_id: int, user_id: int, subtask_id: int):
    return SubtaskContext(
        id=context_id,
        user_id=user_id,
        subtask_id=subtask_id,
        context_type=ContextType.ATTACHMENT.value,
        status=ContextStatus.READY.value,
        name="attachment.txt",
        type_data={
            "original_filename": "attachment.txt",
            "mime_type": "text/plain",
            "file_size": 12,
        },
    )


def test_validate_attachment_ownership_accepts_sharded_same_task_attachment(
    test_db,
    sharded_context_store,
):
    task_id_value = new_task_id(17, 1)
    subtask = shard_subtask(task_id_value=task_id_value, user_id=17, sequence=2)
    test_db.add(subtask)
    test_db.add(attachment_context(context_id=6101, user_id=17, subtask_id=subtask.id))
    test_db.flush()

    valid_ids = contexts_module._validate_attachment_ownership(
        db=test_db,
        attachment_ids=[6101],
        user_id=17,
        task_id=task_id_value,
    )

    assert valid_ids == [6101]
    assert test_db.query(Subtask).count() == 0


def test_validate_attachment_ownership_rejects_sharded_other_task_attachment(
    test_db,
    sharded_context_store,
):
    task_id_value = new_task_id(17, 11)
    other_task_id = new_task_id(17, 12)
    other_subtask = shard_subtask(
        task_id_value=other_task_id,
        user_id=17,
        sequence=13,
    )
    test_db.add(other_subtask)
    test_db.add(
        attachment_context(context_id=6102, user_id=17, subtask_id=other_subtask.id)
    )
    test_db.flush()

    with pytest.raises(HTTPException) as exc_info:
        contexts_module._validate_attachment_ownership(
            db=test_db,
            attachment_ids=[6102],
            user_id=17,
            task_id=task_id_value,
        )

    assert exc_info.value.status_code == 403
    assert test_db.query(Subtask).count() == 0


def test_batch_update_links_sharded_same_task_attachment(
    test_db,
    sharded_context_store,
):
    task_id_value = new_task_id(18, 1)
    existing_subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=18,
        sequence=2,
    )
    target_subtask = shard_subtask(
        task_id_value=task_id_value,
        user_id=18,
        sequence=3,
    )
    test_db.add_all([existing_subtask, target_subtask])
    test_db.add(
        attachment_context(
            context_id=6103,
            user_id=18,
            subtask_id=existing_subtask.id,
        )
    )
    test_db.flush()

    created_ids = contexts_module._batch_update_and_insert_contexts(
        db=test_db,
        attachment_ids=[6103],
        contexts_to_create=[],
        subtask_id=target_subtask.id,
        task_id=task_id_value,
    )

    context = test_db.get(SubtaskContext, 6103)
    assert created_ids == []
    assert context.subtask_id == target_subtask.id
    assert test_db.query(Subtask).count() == 0
