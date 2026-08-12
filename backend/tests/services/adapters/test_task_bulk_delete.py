# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import MagicMock, call, patch

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.task import MAX_TASK_DELETE_BATCH_SIZE, TaskBulkDeleteRequest
from app.services.adapters.task_kinds import TaskKindsService
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore


@pytest.mark.unit
def test_bulk_delete_request_rejects_more_than_fifty_tasks() -> None:
    with pytest.raises(ValidationError):
        TaskBulkDeleteRequest(task_ids=list(range(MAX_TASK_DELETE_BATCH_SIZE + 1)))


@pytest.mark.unit
def test_delete_all_personal_tasks_loads_only_fifty_tasks() -> None:
    service = TaskKindsService(Kind)
    db = MagicMock(spec=Session)
    tasks = [MagicMock(id=task_id) for task_id in range(MAX_TASK_DELETE_BATCH_SIZE)]

    with (
        patch(
            "app.services.adapters.task_kinds.operations.task_stores.task_store."
            "list_archivable_active_tasks",
            return_value=tasks,
        ) as list_tasks,
        patch.object(service, "delete_task") as delete_task,
    ):
        count = service.delete_all_personal_tasks(
            db=db,
            user_id=7,
            client_origin="frontend",
        )

    assert count == MAX_TASK_DELETE_BATCH_SIZE
    list_tasks.assert_called_once_with(
        db,
        user_id=7,
        scope="all",
        client_origin="frontend",
        exclude_group_chats=True,
        limit=MAX_TASK_DELETE_BATCH_SIZE,
    )
    assert delete_task.call_count == MAX_TASK_DELETE_BATCH_SIZE


@pytest.mark.unit
def test_delete_all_personal_tasks_counts_only_successful_deletions() -> None:
    service = TaskKindsService(Kind)
    db = MagicMock(spec=Session)
    tasks = [MagicMock(id=1), MagicMock(id=2), MagicMock(id=3)]

    with (
        patch(
            "app.services.adapters.task_kinds.operations.task_stores.task_store."
            "list_archivable_active_tasks",
            return_value=tasks,
        ),
        patch.object(
            service,
            "delete_task",
            side_effect=[None, RuntimeError("delete failed"), None],
        ),
    ):
        count = service.delete_all_personal_tasks(db=db, user_id=7)

    assert count == 2
    assert db.rollback.call_count == 1


@pytest.mark.unit
def test_bulk_delete_tasks_continues_after_a_failed_deletion() -> None:
    service = TaskKindsService(Kind)
    db = MagicMock(spec=Session)

    with patch.object(
        service,
        "delete_task",
        side_effect=[None, RuntimeError("delete failed"), None],
    ) as delete_task:
        count = service.bulk_delete_tasks(
            db=db,
            task_ids=[1, 2, 3],
            user_id=7,
            client_origin="frontend",
        )

    assert count == 2
    assert delete_task.call_args_list == [
        call(db=db, task_id=1, user_id=7, client_origin="frontend"),
        call(db=db, task_id=2, user_id=7, client_origin="frontend"),
        call(db=db, task_id=3, user_id=7, client_origin="frontend"),
    ]
    db.rollback.assert_called_once_with()


def _create_task(
    db: Session,
    *,
    task_id: int,
    user_id: int,
    is_group_chat: bool | None,
    legacy_group_chat: bool | None,
) -> TaskResource:
    spec: dict[str, object] = {"title": f"Task {task_id}"}
    if legacy_group_chat is not None:
        spec["is_group_chat"] = legacy_group_chat
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={"kind": "Task", "spec": spec},
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=is_group_chat,
        project_id=0,
        client_origin="frontend",
        created_at=datetime(2026, 8, 10, 8, 0, 0),
        updated_at=datetime(2026, 8, 10, 8, 0, 0),
    )
    db.add(task)
    return task


def test_personal_task_query_excludes_legacy_group_chat(
    test_db: Session,
    test_user: User,
) -> None:
    personal_task = _create_task(
        test_db,
        task_id=8101,
        user_id=test_user.id,
        is_group_chat=False,
        legacy_group_chat=False,
    )
    _create_task(
        test_db,
        task_id=8102,
        user_id=test_user.id,
        is_group_chat=False,
        legacy_group_chat=True,
    )
    test_db.commit()

    tasks = SqlAlchemyTaskStore().list_archivable_active_tasks(
        test_db,
        user_id=test_user.id,
        scope="all",
        client_origin="frontend",
        exclude_group_chats=True,
        limit=MAX_TASK_DELETE_BATCH_SIZE,
    )

    assert [task.id for task in tasks] == [personal_task.id]
