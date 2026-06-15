# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.stores.tasks.interfaces import SubtaskStore
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from shared.models.db.enums import ContextType


def test_subtask_store_protocol_declares_all_public_implementation_methods() -> None:
    implementation_methods = {
        name
        for name, value in vars(SqlAlchemySubtaskStore).items()
        if callable(value) and not name.startswith("_")
    }
    protocol_methods = {
        name
        for name, value in vars(SubtaskStore).items()
        if callable(value) and not name.startswith("_")
    }

    assert implementation_methods <= protocol_methods


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
    sender_user_id: int = 0,
    status: SubtaskStatus = SubtaskStatus.COMPLETED,
    executor_name: str = "",
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
        executor_name=executor_name,
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


def test_list_by_task_ordered_excludes_subtasks(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(6, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=61, task_id=6, user_id=10, message_id=2),
            _subtask(subtask_id=62, task_id=6, user_id=10, message_id=1),
            _subtask(subtask_id=63, task_id=6, user_id=10, message_id=3),
        ]
    )
    test_db.commit()

    subtasks = store.list_by_task_ordered(
        test_db,
        task_id=6,
        exclude_subtask_ids=[62],
    )

    assert [subtask.id for subtask in subtasks] == [61, 63]


def test_get_basic_by_id_returns_subtask(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(1, owner_id=10))
    test_db.add(_subtask(subtask_id=11, task_id=1, user_id=10, message_id=1))
    test_db.commit()

    subtask = store.get_basic_by_id(test_db, subtask_id=11)

    assert subtask is not None
    assert subtask.id == 11


def test_subtask_lookup_methods_filter_optional_owner_user_id(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add_all([_task(12, owner_id=10), _task(13, owner_id=20)])
    owned = _subtask(subtask_id=121, task_id=12, user_id=99, message_id=1)
    other = _subtask(subtask_id=131, task_id=13, user_id=99, message_id=1)
    test_db.add_all([owned, other])
    test_db.commit()

    assert store.get_by_id(test_db, subtask_id=owned.id, owner_user_id=10) == owned
    assert store.get_by_id(test_db, subtask_id=owned.id, owner_user_id=20) is None
    assert (
        store.get_basic_by_id(test_db, subtask_id=owned.id, owner_user_id=10) == owned
    )
    assert (
        store.get_basic_by_id(
            test_db,
            subtask_id=owned.id,
            owner_user_id=20,
        )
        is None
    )
    assert store.list_by_task_unfiltered(
        test_db,
        task_id=12,
        owner_user_id=10,
    ) == [owned]
    assert (
        store.list_by_task_unfiltered(
            test_db,
            task_id=12,
            owner_user_id=20,
        )
        == []
    )
    assert store.list_recent_by_task_ids(
        test_db,
        task_ids=[owned.task_id, other.task_id],
        owner_user_id=10,
        limit=10,
    ) == [owned]


def test_list_by_task_ordered_filters_ids_and_deleted_status(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(16, owner_id=10))
    deleted = _subtask(
        subtask_id=161,
        task_id=16,
        user_id=10,
        message_id=1001,
        status=SubtaskStatus.DELETE,
    )
    active = _subtask(subtask_id=162, task_id=16, user_id=10, message_id=1002)
    skipped = _subtask(subtask_id=163, task_id=16, user_id=10, message_id=1003)
    test_db.add_all([deleted, active, skipped])
    test_db.commit()

    subtasks = store.list_by_task_ordered(
        test_db,
        task_id=16,
        message_ids=[deleted.message_id, active.message_id],
        exclude_deleted=True,
        order_by="id",
    )

    assert [subtask.id for subtask in subtasks] == [active.id]


def test_get_by_task_message_or_parent_role(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(17, owner_id=10))
    user_subtask = _subtask(
        subtask_id=171,
        task_id=17,
        user_id=10,
        message_id=1,
        role=SubtaskRole.USER,
    )
    assistant_subtask = _subtask(
        subtask_id=172,
        task_id=17,
        user_id=10,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
    )
    assistant_subtask.parent_id = user_subtask.message_id
    test_db.add_all([user_subtask, assistant_subtask])
    test_db.commit()

    assert (
        store.get_by_task_message_id_and_role(
            test_db,
            task_id=17,
            message_id=1,
            role=SubtaskRole.USER,
        )
        == user_subtask
    )
    assert (
        store.get_by_task_parent_id_and_role(
            test_db,
            task_id=17,
            parent_id=1,
            role=SubtaskRole.ASSISTANT,
        )
        == assistant_subtask
    )


def test_mark_task_subtasks_by_statuses_updates_matching_rows(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(18, owner_id=10))
    pending = _subtask(
        subtask_id=181,
        task_id=18,
        user_id=10,
        message_id=1,
        status=SubtaskStatus.PENDING,
    )
    running = _subtask(
        subtask_id=182,
        task_id=18,
        user_id=10,
        message_id=2,
        status=SubtaskStatus.RUNNING,
    )
    completed = _subtask(
        subtask_id=183,
        task_id=18,
        user_id=10,
        message_id=3,
        status=SubtaskStatus.COMPLETED,
    )
    test_db.add_all([pending, running, completed])
    test_db.commit()

    updated = store.mark_task_subtasks_by_statuses(
        test_db,
        task_id=18,
        from_statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
        to_status=SubtaskStatus.CANCELLED,
        progress=100,
        completed_at=datetime.now(),
    )
    test_db.commit()
    test_db.refresh(pending)
    test_db.refresh(running)
    test_db.refresh(completed)

    assert updated == 2
    assert pending.status == SubtaskStatus.CANCELLED
    assert running.status == SubtaskStatus.CANCELLED
    assert completed.status == SubtaskStatus.COMPLETED


def test_mark_task_subtasks_deleted_filters_optional_owner_user_id(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(19, owner_id=10))
    owned = _subtask(subtask_id=191, task_id=19, user_id=99, message_id=1)
    test_db.add(owned)
    test_db.commit()

    wrong_owner_count = store.mark_task_subtasks_deleted(
        test_db,
        task_id=19,
        owner_user_id=20,
    )
    test_db.commit()
    test_db.refresh(owned)

    assert wrong_owner_count == 0
    assert owned.status == SubtaskStatus.COMPLETED

    owner_count = store.mark_task_subtasks_deleted(
        test_db,
        task_id=19,
        owner_user_id=10,
    )
    test_db.commit()
    test_db.refresh(owned)

    assert owner_count == 1
    assert owned.status == SubtaskStatus.DELETE


def test_list_by_task_status_filters_status(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(7, owner_id=10))
    test_db.add_all(
        [
            _subtask(
                subtask_id=71,
                task_id=7,
                user_id=10,
                message_id=1,
                status=SubtaskStatus.PENDING,
            ),
            _subtask(
                subtask_id=72,
                task_id=7,
                user_id=10,
                message_id=2,
                status=SubtaskStatus.RUNNING,
            ),
        ]
    )
    test_db.commit()

    subtasks = store.list_by_task_status(
        test_db,
        task_id=7,
        status=SubtaskStatus.PENDING,
    )

    assert [subtask.id for subtask in subtasks] == [71]


def test_list_running_device_subtasks_filters_device_executors(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(8, owner_id=10))
    test_db.add_all(
        [
            _subtask(
                subtask_id=81,
                task_id=8,
                user_id=10,
                message_id=1,
                status=SubtaskStatus.RUNNING,
                executor_name="device-local",
            ),
            _subtask(
                subtask_id=82,
                task_id=8,
                user_id=10,
                message_id=2,
                status=SubtaskStatus.RUNNING,
                executor_name="pod-local",
            ),
            _subtask(
                subtask_id=83,
                task_id=8,
                user_id=10,
                message_id=3,
                status=SubtaskStatus.COMPLETED,
                executor_name="device-local",
            ),
        ]
    )
    test_db.commit()

    subtasks = store.list_running_device_subtasks(test_db)

    assert [subtask.id for subtask in subtasks] == [81]


def test_list_running_by_executor_name_filters_status(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(9, owner_id=10))
    test_db.add_all(
        [
            _subtask(
                subtask_id=91,
                task_id=9,
                user_id=10,
                message_id=1,
                status=SubtaskStatus.RUNNING,
                executor_name="device-a",
            ),
            _subtask(
                subtask_id=92,
                task_id=9,
                user_id=10,
                message_id=2,
                status=SubtaskStatus.COMPLETED,
                executor_name="device-a",
            ),
        ]
    )
    test_db.commit()

    subtasks = store.list_running_by_executor_name(
        test_db,
        executor_name="device-a",
    )

    assert [subtask.id for subtask in subtasks] == [91]


def test_list_by_task_for_user_ordered_filters_user(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(10, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=101, task_id=10, user_id=10, message_id=2),
            _subtask(subtask_id=102, task_id=10, user_id=20, message_id=1),
            _subtask(subtask_id=103, task_id=10, user_id=10, message_id=3),
        ]
    )
    test_db.commit()

    subtasks = store.list_by_task_for_user_ordered(
        test_db,
        task_id=10,
        user_id=10,
    )

    assert [subtask.id for subtask in subtasks] == [101, 103]


def test_list_history_by_task_statuses_applies_before_and_latest_limit(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(11, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=111, task_id=11, user_id=10, message_id=1),
            _subtask(subtask_id=112, task_id=11, user_id=10, message_id=2),
            _subtask(subtask_id=113, task_id=11, user_id=10, message_id=3),
            _subtask(
                subtask_id=114,
                task_id=11,
                user_id=10,
                message_id=4,
                status=SubtaskStatus.DELETE,
            ),
        ]
    )
    test_db.commit()

    subtasks = store.list_history_by_task_statuses(
        test_db,
        task_id=11,
        statuses=[SubtaskStatus.COMPLETED],
        before_message_id=4,
        limit=2,
    )

    assert [subtask.message_id for subtask in subtasks] == [2, 3]


def test_get_next_message_id_and_first_by_task(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(12, owner_id=10))
    first = _subtask(subtask_id=121, task_id=12, user_id=10, message_id=2)
    second = _subtask(subtask_id=122, task_id=12, user_id=10, message_id=5)
    test_db.add_all([first, second])
    test_db.commit()

    assert store.get_first_by_task(test_db, task_id=12) == first
    assert store.get_next_message_id(test_db, task_id=12) == 6
    assert store.get_next_message_id(test_db, task_id=999) == 1


def test_get_latest_running_assistant_for_user_by_statuses(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(13, owner_id=10))
    test_db.add_all(
        [
            _subtask(
                subtask_id=131,
                task_id=13,
                user_id=10,
                message_id=1,
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.PENDING,
            ),
            _subtask(
                subtask_id=132,
                task_id=13,
                user_id=10,
                message_id=2,
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
            ),
        ]
    )
    test_db.commit()

    subtask = store.get_latest_assistant_for_user_by_statuses(
        test_db,
        task_id=13,
        user_id=10,
        statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
    )

    assert subtask.id == 132


def test_mark_task_messages_status_and_list_session_task_ids(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add_all([_task(14, owner_id=10), _task(15, owner_id=10)])
    test_db.add_all(
        [
            _subtask(subtask_id=141, task_id=14, user_id=10, message_id=1),
            _subtask(subtask_id=151, task_id=15, user_id=10, message_id=1),
        ]
    )
    test_db.commit()

    updated = store.mark_task_messages_status(
        test_db,
        task_id=14,
        status=SubtaskStatus.DELETE,
    )
    test_db.commit()

    assert updated == 1
    assert store.list_session_task_ids(test_db, skip=0, limit=10) == [15]


def test_get_latest_active_executor_for_task(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(16, owner_id=10))
    test_db.add_all(
        [
            _subtask(
                subtask_id=161,
                task_id=16,
                user_id=10,
                message_id=1,
                executor_name="old",
            ),
            _subtask(
                subtask_id=162,
                task_id=16,
                user_id=10,
                message_id=2,
                executor_name="deleted",
            ),
            _subtask(
                subtask_id=163,
                task_id=16,
                user_id=10,
                message_id=3,
                executor_name="new",
            ),
        ]
    )
    test_db.flush()
    test_db.get(Subtask, 162).executor_deleted_at = True
    test_db.commit()

    subtask = store.get_latest_active_executor_for_task(test_db, task_id=16)

    assert subtask.id == 163


def test_list_by_task_from_latest_preserves_message_id_order(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    access_store = SqlAlchemyTaskAccessStore()
    test_db.add(_task(1, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=1, task_id=1, user_id=10, message_id=1),
            _subtask(subtask_id=2, task_id=1, user_id=10, message_id=2),
            _subtask(subtask_id=3, task_id=1, user_id=10, message_id=3),
            _subtask(subtask_id=4, task_id=1, user_id=10, message_id=4),
        ]
    )
    test_db.commit()

    subtasks = store.list_by_task(
        test_db,
        task_id=1,
        user_id=10,
        access_store=access_store,
        from_latest=True,
        limit=2,
    )

    assert [subtask.message_id for subtask in subtasks] == [3, 4]


def test_group_member_can_read_all_task_messages(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    access_store = SqlAlchemyTaskAccessStore()
    test_db.add(_task(2, owner_id=10, is_group_chat=True))
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=2,
            entity_type="user",
            entity_id="20",
            user_id=20,
            role=ResourceRole.Maintainer.value,
            status=MemberStatus.APPROVED,
            copied_resource_id=0,
        )
    )
    test_db.add_all(
        [
            _subtask(subtask_id=11, task_id=2, user_id=10, message_id=1),
            _subtask(
                subtask_id=12,
                task_id=2,
                user_id=30,
                message_id=2,
                sender_user_id=30,
            ),
            _subtask(subtask_id=13, task_id=2, user_id=10, message_id=3),
        ]
    )
    test_db.add(
        User(
            id=30,
            user_name="sender",
            password_hash="hash",
            email="sender@example.com",
            is_active=True,
        )
    )
    test_db.commit()

    subtasks = store.list_by_task(
        test_db,
        task_id=2,
        user_id=20,
        access_store=access_store,
    )

    assert [subtask.message_id for subtask in subtasks] == [1, 2, 3]
    assert subtasks[1].sender_user_name == "sender"


def test_delete_from_message_id_resets_attachment_contexts_and_deletes_others(
    test_db: Session,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(3, owner_id=10))
    test_db.add_all(
        [
            _subtask(subtask_id=21, task_id=3, user_id=10, message_id=1),
            _subtask(subtask_id=22, task_id=3, user_id=10, message_id=2),
        ]
    )
    test_db.add_all(
        [
            SubtaskContext(
                id=31,
                subtask_id=22,
                user_id=10,
                context_type=ContextType.ATTACHMENT.value,
                name="attachment.pdf",
                type_data={},
            ),
            SubtaskContext(
                id=32,
                subtask_id=22,
                user_id=10,
                context_type=ContextType.KNOWLEDGE_BASE.value,
                name="knowledge",
                type_data={},
            ),
        ]
    )
    test_db.commit()

    deleted_count = store.delete_from_message_id(
        test_db,
        task_id=3,
        from_message_id=2,
    )
    test_db.flush()

    assert deleted_count == 1
    assert test_db.get(Subtask, 22) is None
    attachment = test_db.get(SubtaskContext, 31)
    assert attachment is not None
    assert attachment.subtask_id == 0
    assert test_db.get(SubtaskContext, 32) is None


def test_delete_from_message_id_does_not_commit(
    test_db: Session,
    monkeypatch,
) -> None:
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(4, owner_id=10))
    test_db.add(_subtask(subtask_id=41, task_id=4, user_id=10, message_id=1))
    test_db.commit()

    def fail_commit() -> None:
        raise AssertionError("store must not commit")

    monkeypatch.setattr(test_db, "commit", fail_commit)

    deleted_count = store.delete_from_message_id(
        test_db,
        task_id=4,
        from_message_id=1,
    )

    assert deleted_count == 1


def test_count_by_task_for_user_uses_group_membership(test_db: Session) -> None:
    store = SqlAlchemySubtaskStore()
    access_store = SqlAlchemyTaskAccessStore()
    test_db.add(_task(5, owner_id=10, is_group_chat=True))
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=5,
            entity_type="user",
            entity_id="20",
            user_id=20,
            role=ResourceRole.Maintainer.value,
            status=MemberStatus.APPROVED,
            copied_resource_id=0,
        )
    )
    test_db.add_all(
        [
            _subtask(subtask_id=51, task_id=5, user_id=10, message_id=1),
            _subtask(subtask_id=52, task_id=5, user_id=30, message_id=2),
            _subtask(subtask_id=53, task_id=5, user_id=30, message_id=3),
        ]
    )
    test_db.commit()

    member_count = store.count_by_task_for_user(
        test_db,
        task_id=5,
        user_id=20,
        access_store=access_store,
    )
    non_member_count = store.count_by_task_for_user(
        test_db,
        task_id=5,
        user_id=30,
        access_store=access_store,
    )

    assert member_count == 3
    assert non_member_count == 2
