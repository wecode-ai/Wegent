from datetime import datetime

import pytest

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from wecode.task_sharding.legacy_migration import (
    compare_legacy_task_shards,
    migrate_legacy_task_shards,
)
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_owner,
    task_model_for_user,
)

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        subtask_model_for_owner(uid).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


def test_migrate_legacy_task_shards_copies_rows_and_keeps_legacy_index(test_db):
    owner_id = 81
    task = TaskResource(
        id=8101,
        user_id=owner_id,
        kind="Task",
        name="legacy-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    now = datetime.now()
    subtask = Subtask(
        id=18101,
        user_id=owner_id,
        task_id=task.id,
        team_id=25,
        title="legacy-message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="legacy prompt",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"ok": True},
        completed_at=now,
        created_at=now,
    )
    test_db.add_all([task, subtask])
    test_db.flush()

    result = migrate_legacy_task_shards(test_db, batch_size=10, dry_run=False)
    second = migrate_legacy_task_shards(test_db, batch_size=10, dry_run=False)

    task_model = task_model_for_user(owner_id)
    subtask_model = subtask_model_for_owner(owner_id)
    migrated_task = test_db.query(task_model).filter(task_model.id == task.id).one()
    migrated_subtask = (
        test_db.query(subtask_model).filter(subtask_model.id == subtask.id).one()
    )

    assert result.tasks_copied == 1
    assert result.subtasks_copied == 1
    assert second.tasks_copied == 0
    assert second.subtasks_copied == 0
    assert test_db.query(TaskResource).filter(TaskResource.id == task.id).one()
    assert test_db.query(Subtask).filter(Subtask.id == subtask.id).one()
    assert migrated_task.name == "legacy-task"
    assert migrated_subtask.prompt == "legacy prompt"


def test_compare_legacy_task_shards_reports_missing_and_mismatched_rows(test_db):
    owner_id = 82
    task = TaskResource(
        id=8201,
        user_id=owner_id,
        kind="Task",
        name="legacy-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    mismatch_task = TaskResource(
        id=8202,
        user_id=owner_id,
        kind="Task",
        name="legacy-task-mismatch",
        namespace="default",
        json={"kind": "Task"},
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    now = datetime.now()
    subtask = Subtask(
        id=18201,
        user_id=owner_id,
        task_id=task.id,
        team_id=25,
        title="legacy-message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="legacy prompt",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"ok": True},
        completed_at=now,
        created_at=now,
    )
    test_db.add_all([task, mismatch_task, subtask])
    test_db.flush()

    migrate_legacy_task_shards(test_db, batch_size=10, dry_run=False)
    task_model = task_model_for_user(owner_id)
    subtask_model = subtask_model_for_owner(owner_id)
    test_db.query(task_model).filter(task_model.id == task.id).delete()
    test_db.query(task_model).filter(task_model.id == mismatch_task.id).update(
        {"name": "changed-in-shard"}
    )
    test_db.query(subtask_model).filter(subtask_model.id == subtask.id).update(
        {"prompt": "changed-in-shard"}
    )
    test_db.flush()

    result = compare_legacy_task_shards(test_db, batch_size=10)

    assert result.legacy_tasks >= 2
    assert result.missing_tasks == 1
    assert result.mismatched_tasks == 1
    assert result.legacy_subtasks >= 1
    assert result.mismatched_subtasks == 1
    assert ("task", task.id, "missing", ()) in {
        (detail.row_type, detail.row_id, detail.issue, detail.fields)
        for detail in result.details
    }
    mismatched_task = next(
        detail
        for detail in result.details
        if detail.row_type == "task"
        and detail.row_id == mismatch_task.id
        and detail.issue == "mismatched"
    )
    assert set(mismatched_task.fields) == {"name", "updated_at"}
    assert ("subtask", subtask.id, "mismatched", ("prompt",)) in {
        (detail.row_type, detail.row_id, detail.issue, detail.fields)
        for detail in result.details
    }

    ignored = compare_legacy_task_shards(
        test_db,
        batch_size=10,
        ignore_task_fields=("name", "updated_at"),
    )

    assert ignored.mismatched_tasks == 0
    assert ignored.mismatched_subtasks == 1


def test_migrate_legacy_task_shards_can_filter_by_user_id(test_db):
    first_owner_id = 83
    second_owner_id = 84
    first_task = TaskResource(
        id=8301,
        user_id=first_owner_id,
        kind="Task",
        name="first-owner-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    second_task = TaskResource(
        id=8401,
        user_id=second_owner_id,
        kind="Task",
        name="second-owner-task",
        namespace="default",
        json={"kind": "Task"},
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    now = datetime.now()
    first_subtask = Subtask(
        id=18301,
        user_id=first_owner_id,
        task_id=first_task.id,
        team_id=25,
        title="first-message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="first prompt",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"ok": True},
        completed_at=now,
        created_at=now,
    )
    second_subtask = Subtask(
        id=18401,
        user_id=second_owner_id,
        task_id=second_task.id,
        team_id=25,
        title="second-message",
        bot_ids=[3],
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt="second prompt",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="",
        result={"ok": True},
        completed_at=now,
        created_at=now,
    )
    test_db.add_all([first_task, second_task, first_subtask, second_subtask])
    test_db.flush()

    result = migrate_legacy_task_shards(
        test_db,
        batch_size=10,
        dry_run=False,
        user_id=first_owner_id,
    )

    first_task_model = task_model_for_user(first_owner_id)
    first_subtask_model = subtask_model_for_owner(first_owner_id)
    second_task_model = task_model_for_user(second_owner_id)
    second_subtask_model = subtask_model_for_owner(second_owner_id)

    assert result.tasks_seen == 1
    assert result.tasks_copied == 1
    assert result.subtasks_seen == 1
    assert result.subtasks_copied == 1
    assert test_db.query(first_task_model).filter(first_task_model.id == 8301).one()
    assert (
        test_db.query(first_subtask_model).filter(first_subtask_model.id == 18301).one()
    )
    assert (
        test_db.query(second_task_model).filter(second_task_model.id == 8401).first()
        is None
    )
    assert (
        test_db.query(second_subtask_model)
        .filter(second_subtask_model.id == 18401)
        .first()
        is None
    )
