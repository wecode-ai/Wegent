# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.task_kinds.task_detail_helpers import (
    filter_conversation_contexts_for_viewer,
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
