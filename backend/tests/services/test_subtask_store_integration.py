# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.subtask import SubtaskCreate, SubtaskUpdate
from app.services.subtask import subtask_service
from shared.models.db.enums import ContextType


def _task(task_id: int, owner_id: int, *, is_group_chat: bool = False) -> TaskResource:
    return TaskResource(
        id=task_id,
        user_id=owner_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {"is_group_chat": is_group_chat},
            "status": {"status": "PENDING"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=is_group_chat,
    )


def _subtask(
    *,
    subtask_id: int,
    task_id: int,
    user_id: int,
    message_id: int,
    role: SubtaskRole = SubtaskRole.USER,
    status: SubtaskStatus = SubtaskStatus.COMPLETED,
    sender_user_id: int = 0,
) -> Subtask:
    return Subtask(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id,
        team_id=1,
        title=f"message-{message_id}",
        bot_ids=[],
        role=role,
        executor_namespace="",
        executor_name="",
        prompt=f"prompt-{message_id}",
        status=status,
        progress=100,
        message_id=message_id,
        parent_id=max(message_id - 1, 0),
        error_message="",
        completed_at=datetime.now(),
        created_at=datetime.now() + timedelta(seconds=message_id),
        sender_user_id=sender_user_id,
    )


def _add_member(test_db: Session, *, task_id: int, user_id: int) -> None:
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=task_id,
            entity_type="user",
            entity_id=str(user_id),
            user_id=user_id,
            role=ResourceRole.Maintainer.value,
            status=MemberStatus.APPROVED,
            copied_resource_id=0,
        )
    )


def test_create_subtask(test_db: Session) -> None:
    test_db.add(_task(101, owner_id=10))
    test_db.commit()

    subtask = subtask_service.create_subtask(
        test_db,
        obj_in=SubtaskCreate(
            task_id=101,
            team_id=1,
            title="created",
            bot_ids=[],
            executor_namespace="ns",
            executor_name="exec",
            message_id=1,
        ),
        user_id=10,
    )

    persisted = test_db.get(Subtask, subtask.id)
    assert persisted is not None
    assert persisted.user_id == 10
    assert persisted.status == SubtaskStatus.PENDING


def test_update_subtask(test_db: Session) -> None:
    test_db.add(_task(102, owner_id=10))
    test_db.add(_subtask(subtask_id=1021, task_id=102, user_id=10, message_id=1))
    test_db.commit()

    updated = subtask_service.update_subtask(
        test_db,
        subtask_id=1021,
        obj_in=SubtaskUpdate(title="updated", progress=42),
        user_id=10,
    )

    assert updated.title == "updated"
    assert updated.progress == 42


def test_delete_subtask(test_db: Session) -> None:
    test_db.add(_task(103, owner_id=10))
    test_db.add(_subtask(subtask_id=1031, task_id=103, user_id=10, message_id=1))
    test_db.commit()

    subtask_service.delete_subtask(test_db, subtask_id=1031, user_id=10)

    assert test_db.get(Subtask, 1031) is None


def test_get_by_task_latest_pagination(test_db: Session) -> None:
    test_db.add(_task(104, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=1041, task_id=104, user_id=10, message_id=1),
            _subtask(subtask_id=1042, task_id=104, user_id=10, message_id=2),
            _subtask(subtask_id=1043, task_id=104, user_id=10, message_id=3),
        ]
    )
    test_db.commit()

    subtasks = subtask_service.get_by_task(
        test_db,
        task_id=104,
        user_id=10,
        from_latest=True,
        limit=2,
    )

    assert [subtask.message_id for subtask in subtasks] == [2, 3]


def test_group_chat_member_can_read_all_messages(test_db: Session) -> None:
    test_db.add(_task(105, owner_id=10, is_group_chat=True))
    _add_member(test_db, task_id=105, user_id=20)
    test_db.add(
        User(
            id=30,
            user_name="sender",
            password_hash="hash",
            email="sender@example.com",
            is_active=True,
        )
    )
    test_db.add_all(
        [
            _subtask(subtask_id=1051, task_id=105, user_id=10, message_id=1),
            _subtask(
                subtask_id=1052,
                task_id=105,
                user_id=30,
                message_id=2,
                sender_user_id=30,
            ),
        ]
    )
    test_db.commit()

    subtasks = subtask_service.get_by_task(test_db, task_id=105, user_id=20)

    assert [subtask.message_id for subtask in subtasks] == [1, 2]
    assert subtasks[1].sender_user_name == "sender"


def test_non_member_only_reads_own_messages(test_db: Session) -> None:
    test_db.add(_task(106, owner_id=10, is_group_chat=True))
    test_db.add_all(
        [
            _subtask(subtask_id=1061, task_id=106, user_id=10, message_id=1),
            _subtask(subtask_id=1062, task_id=106, user_id=30, message_id=2),
            _subtask(subtask_id=1063, task_id=106, user_id=30, message_id=3),
        ]
    )
    test_db.commit()

    subtasks = subtask_service.get_by_task(test_db, task_id=106, user_id=30)

    assert [subtask.message_id for subtask in subtasks] == [2, 3]


def test_edit_user_message_deletes_edited_message_and_later_messages(
    test_db: Session,
) -> None:
    test_db.add(_task(107, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=1071, task_id=107, user_id=10, message_id=1),
            _subtask(subtask_id=1072, task_id=107, user_id=10, message_id=2),
            _subtask(
                subtask_id=1073,
                task_id=107,
                user_id=10,
                message_id=3,
                role=SubtaskRole.ASSISTANT,
            ),
        ]
    )
    test_db.add_all(
        [
            SubtaskContext(
                id=10721,
                subtask_id=1072,
                user_id=10,
                context_type=ContextType.ATTACHMENT.value,
                name="attachment.pdf",
                type_data={},
            ),
            SubtaskContext(
                id=10722,
                subtask_id=1072,
                user_id=10,
                context_type=ContextType.KNOWLEDGE_BASE.value,
                name="knowledge",
                type_data={},
            ),
        ]
    )
    test_db.commit()

    returned_subtask_id, message_id, deleted_count = subtask_service.edit_user_message(
        test_db,
        subtask_id=1072,
        new_content="edited",
        user_id=10,
    )

    assert (returned_subtask_id, message_id, deleted_count) == (1072, 2, 2)
    assert test_db.get(Subtask, 1071) is not None
    assert test_db.get(Subtask, 1072) is None
    assert test_db.get(Subtask, 1073) is None
    attachment = test_db.get(SubtaskContext, 10721)
    assert attachment is not None
    assert attachment.subtask_id == 0
    assert test_db.get(SubtaskContext, 10722) is None


def test_edit_user_message_rejects_running_assistant(test_db: Session) -> None:
    test_db.add(_task(108, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=1081, task_id=108, user_id=10, message_id=1),
            _subtask(
                subtask_id=1082,
                task_id=108,
                user_id=10,
                message_id=2,
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
            ),
        ]
    )
    test_db.commit()

    try:
        subtask_service.edit_user_message(
            test_db,
            subtask_id=1081,
            new_content="edited",
            user_id=10,
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Cannot edit while AI is generating a response"
    else:
        raise AssertionError("Expected edit to fail while assistant is running")
