# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.task_kinds.task_detail_helpers import (
    filter_conversation_contexts_for_viewer,
    filter_conversation_contexts_on_subtasks,
)


def _create_private_task(db: Session, user: User) -> TaskResource:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name=f"private-task-{user.id}",
        namespace="default",
        json={
            "metadata": {"name": f"private-task-{user.id}", "namespace": "default"},
            "spec": {"title": "Private task"},
            "status": {"status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _create_other_user(db: Session) -> User:
    user = User(
        user_name="conversation-viewer",
        password_hash="x",
        email="conversation-viewer@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_filter_conversation_contexts_hides_inaccessible_references(
    test_db: Session,
    test_user: User,
) -> None:
    source_task = _create_private_task(test_db, test_user)
    viewer = _create_other_user(test_db)
    subtasks = [
        {
            "id": 1,
            "contexts": [
                {
                    "id": 11,
                    "context_type": "conversation",
                    "name": "Private task",
                    "task_id": source_task.id,
                },
                {
                    "id": 12,
                    "context_type": "knowledge_base",
                    "name": "Specs",
                },
            ],
        }
    ]

    filter_conversation_contexts_for_viewer(
        test_db, subtasks=subtasks, user_id=viewer.id
    )
    assert [context["context_type"] for context in subtasks[0]["contexts"]] == [
        "knowledge_base"
    ]


def test_filter_conversation_contexts_keeps_owner_visible_references(
    test_db: Session,
    test_user: User,
) -> None:
    source_task = _create_private_task(test_db, test_user)
    subtasks = [
        {
            "id": 1,
            "contexts": [
                {
                    "id": 11,
                    "context_type": "conversation",
                    "name": "Private task",
                    "task_id": source_task.id,
                }
            ],
        }
    ]

    filter_conversation_contexts_for_viewer(
        test_db, subtasks=subtasks, user_id=test_user.id
    )
    assert subtasks[0]["contexts"][0]["task_id"] == source_task.id


def _create_subtask_with_reference(
    db: Session, *, owner: User, source_task: TaskResource
) -> Subtask:
    subtask = Subtask(
        user_id=owner.id,
        task_id=source_task.id,
        team_id=1,
        title="",
        bot_ids=[1],
        role=SubtaskRole.USER,
        prompt="continue",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=1,
        parent_id=0,
    )
    db.add(subtask)
    db.commit()
    db.refresh(subtask)
    db.add(
        SubtaskContext(
            subtask_id=subtask.id,
            user_id=owner.id,
            context_type=ContextType.CONVERSATION.value,
            name="Private task",
            status=ContextStatus.READY.value,
            type_data={"task_id": source_task.id},
        )
    )
    db.commit()
    db.refresh(subtask)
    return subtask


def test_subtask_contexts_hide_inaccessible_references(
    test_db: Session,
    test_user: User,
) -> None:
    source_task = _create_private_task(test_db, test_user)
    viewer = _create_other_user(test_db)
    subtask = _create_subtask_with_reference(
        test_db, owner=viewer, source_task=source_task
    )

    filter_conversation_contexts_on_subtasks(
        test_db, subtasks=[subtask], user_id=viewer.id
    )

    assert subtask.contexts == []


def test_subtask_contexts_keep_owner_visible_references(
    test_db: Session,
    test_user: User,
) -> None:
    source_task = _create_private_task(test_db, test_user)
    subtask = _create_subtask_with_reference(
        test_db, owner=test_user, source_task=source_task
    )

    filter_conversation_contexts_on_subtasks(
        test_db, subtasks=[subtask], user_id=test_user.id
    )

    assert len(subtask.contexts) == 1
    assert subtask.contexts[0].type_data["task_id"] == source_task.id
