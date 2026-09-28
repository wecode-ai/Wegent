from datetime import datetime

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore


@pytest.fixture
def runtime_task(test_db: Session) -> TaskResource:
    task = TaskResource(
        id=42,
        user_id=10,
        kind="Task",
        name="runtime-task",
        namespace="default",
        json={
            "status": {
                "status": "RUNNING",
                "updatedAt": "2026-09-18T11:50:00",
                "result": {"messages_chain": ["private message"] * 1000},
            }
        },
        updated_at=datetime(2026, 9, 18, 11, 51),
    )
    test_db.add(task)
    test_db.flush()
    return task


def test_runtime_state_projects_only_checkpoint_fields(test_db, runtime_task):
    statements = []
    connection = test_db.connection()

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(connection, "before_cursor_execute", capture)
    try:
        state = SqlAlchemyTaskAccessStore().get_runtime_state(
            test_db, task_id=42, user_id=10
        )
    finally:
        event.remove(connection, "before_cursor_execute", capture)

    assert state.status == "RUNNING"
    assert state.updated_at == "2026-09-18T11:50:00"
    assert len(statements) == 1
    projection = statements[0].split("\nFROM")[0]
    assert "JSON_EXTRACT" in projection
    assert "tasks.json AS" not in projection
    assert "messages_chain" not in statements[0]


@pytest.mark.parametrize("value", [None, "2026-09-18T11:50:00"])
def test_runtime_state_preserves_status_timestamp_precedence(
    test_db, runtime_task, value
):
    runtime_task.json = {"status": {"status": "COMPLETED", "updatedAt": value}}
    test_db.flush()
    state = SqlAlchemyTaskAccessStore().get_runtime_state(
        test_db, task_id=42, user_id=10
    )
    assert state.updated_at == (value or runtime_task.updated_at)


@pytest.mark.parametrize(
    "changes,allowed",
    [
        ({}, True),
        ({"status": MemberStatus.PENDING}, False),
        ({"status": MemberStatus.REJECTED}, False),
        ({"copied_resource_id": 99}, False),
        ({"entity_type": "namespace"}, False),
        ({"entity_id": "30"}, False),
        ({"resource_type": ResourceType.TEAM}, False),
        ({"resource_id": 43}, False),
    ],
)
def test_runtime_state_preserves_member_policy(test_db, runtime_task, changes, allowed):
    fields = dict(
        resource_type=ResourceType.TASK,
        resource_id=42,
        entity_type="user",
        entity_id="20",
        status=MemberStatus.APPROVED,
        copied_resource_id=0,
    )
    test_db.add(ResourceMember(**(fields | changes)))
    test_db.flush()
    store = SqlAlchemyTaskAccessStore()
    assert store.is_member(test_db, task_id=42, user_id=20) is allowed
    assert (
        store.get_runtime_state(test_db, task_id=42, user_id=20) is not None
    ) is allowed


@pytest.mark.parametrize(
    "kind,active,status,allowed",
    [
        ("Task", TaskResource.STATE_ACTIVE, "RUNNING", True),
        ("Task", TaskResource.STATE_SUBSCRIPTION, "COMPLETED", True),
        ("Task", TaskResource.STATE_DELETED, "RUNNING", False),
        ("Task", TaskResource.STATE_ARCHIVED, "RUNNING", False),
        ("Task", TaskResource.STATE_ACTIVE, "DELETE", False),
        ("Workspace", TaskResource.STATE_ACTIVE, "RUNNING", False),
    ],
)
def test_runtime_state_filters_resource_state(
    test_db, runtime_task, kind, active, status, allowed
):
    runtime_task.kind = kind
    runtime_task.is_active = active
    runtime_task.json = {"status": {"status": status}}
    test_db.flush()
    state = SqlAlchemyTaskAccessStore().get_runtime_state(
        test_db, task_id=42, user_id=10
    )
    assert (state is not None) is allowed


def test_runtime_state_denies_nonmember_and_missing_task(test_db, runtime_task):
    store = SqlAlchemyTaskAccessStore()
    assert store.get_runtime_state(test_db, task_id=42, user_id=20) is None
    assert store.get_runtime_state(test_db, task_id=999, user_id=10) is None
