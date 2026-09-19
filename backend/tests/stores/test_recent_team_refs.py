"""Verify narrow recent-team reads against the existing task selection."""

from datetime import datetime

import pytest
from sqlalchemy import event

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore


@pytest.fixture
def store_and_model():
    return SqlAlchemyTaskStore(), TaskResource


def test_projection_preserves_selection_without_loading_tasks(test_db, store_and_model):
    store, model = store_and_model
    for index in range(1, 8):
        test_db.add(
            model(
                id=9000 + index,
                user_id=8 if index == 5 else 7,
                kind="Workspace" if index == 6 else "Task",
                namespace="default",
                name=f"task-{index}",
                is_active=0 if index == 4 else 1,
                is_group_chat=index == 3,
                json={
                    "metadata": {"labels": {"taskType": "chat"}},
                    "spec": {
                        "teamRef": {"name": f"team-{index}", "user_id": 7},
                        "unneeded": "x" * 100_000,
                    },
                },
                updated_at=datetime(2026, 9, 18),
            )
        )
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=9007,
            entity_id="8",
            status=MemberStatus.APPROVED,
        )
    )
    test_db.commit()
    original = store.list_recent_owner_only_tasks(test_db, user_id=7, limit=1)
    expected = [task.json["spec"]["teamRef"] for task in original]
    assert expected == [{"name": "team-2", "user_id": 7}]
    test_db.expunge_all()
    statements = []

    def record_sql(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    connection = test_db.connection()
    event.listen(connection, "before_cursor_execute", record_sql)
    try:
        refs = store.list_recent_task_team_refs(test_db, user_id=7, limit=1)
    finally:
        event.remove(connection, "before_cursor_execute", record_sql)

    assert [ref.team_ref for ref in refs] == expected
    assert [ref.task_type for ref in refs] == ["chat"]
    assert len(test_db.identity_map) == 0
    assert len(statements) == 1
    assert "JSON_EXTRACT" in statements[0]


def test_projection_handles_missing_and_malformed_json(test_db, store_and_model):
    store, model = store_and_model
    payloads = [
        None,
        [],
        {},
        {"metadata": [], "spec": "bad"},
        {"metadata": {"labels": {"taskType": None}}, "spec": {"teamRef": None}},
    ]
    for index, payload in enumerate(payloads):
        test_db.add(
            model(
                id=9100 + index,
                user_id=7,
                kind="Task",
                namespace="default",
                name=f"malformed-{index}",
                json=payload,
                is_active=1,
                is_group_chat=False,
                updated_at=datetime(2026, 9, 18),
            )
        )
    test_db.commit()

    refs = store.list_recent_task_team_refs(test_db, user_id=7, limit=50)

    assert len(refs) == len(payloads)
    assert all(ref.task_type is None and ref.team_ref is None for ref in refs)
    assert store.list_recent_task_team_refs(test_db, user_id=7, limit=0) == []
