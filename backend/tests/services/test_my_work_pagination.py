"""My Work keyset pages retain permissions and advance through unprojectable rows."""

import base64
import json
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import _make_project


def add_items(
    db: Session,
    project: CloudProject,
    user_id: int,
    count: int,
    *,
    prefix: str = "PAGE",
    same_time: bool = False,
) -> list[LoopItem]:
    start = datetime(2026, 1, 1)
    rows = [
        LoopItem(
            id=f"{prefix}-{index:03d}",
            cloud_project_id=project.id,
            title=f"Work {index}",
            description="",
            status="pending",
            priority="none",
            sequence_number=index + 1,
            created_by_user_id=user_id,
            metadata_json={},
            updated_at=start if same_time else start + timedelta(minutes=index),
        )
        for index in range(count)
    ]
    db.add_all(rows)
    db.commit()
    return rows


def test_pages_reach_items_beyond_the_cap_with_equal_timestamp_tiebreaker(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 105, same_time=True)

    first, cursor = loop_item_service.list_my_work_page(test_db, test_user.id)
    second, final_cursor = loop_item_service.list_my_work_page(
        test_db, test_user.id, cursor=cursor
    )

    assert cursor is not None
    assert final_cursor is None
    assert [row["id"] for row in first + second] == [row.id for row in reversed(rows)]
    assert len(first) == 100
    assert len(second) == 5
    assert loop_item_service.list_my_work(test_db, test_user.id) == first


def test_newer_insert_does_not_shift_the_remaining_page(test_db, test_user):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 3)
    first, cursor = loop_item_service.list_my_work_page(test_db, test_user.id, limit=1)
    inserted = add_items(test_db, project, test_user.id, 1, prefix="NEW")[0]
    inserted.updated_at = datetime(2026, 2, 1)
    test_db.commit()

    second, next_cursor = loop_item_service.list_my_work_page(
        test_db, test_user.id, cursor=cursor, limit=2
    )

    assert [row["id"] for row in first] == [rows[2].id]
    assert [row["id"] for row in second] == [rows[1].id, rows[0].id]
    assert next_cursor is None


def test_every_page_retains_project_related_item_and_deletion_filters(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 3)
    other = User(user_name="pagination-other", password_hash="unused", is_active=True)
    test_db.add(other)
    test_db.commit()
    denied_project = _make_project(test_db, other)
    add_items(test_db, denied_project, test_user.id, 1, prefix="DENIED")
    add_items(test_db, project, other.id, 1, prefix="UNRELATED")
    deleted = add_items(test_db, project, test_user.id, 1, prefix="DELETED")[0]
    deleted.deleted_at = datetime(2026, 1, 2)
    test_db.commit()

    first, cursor = loop_item_service.list_my_work_page(test_db, test_user.id, limit=1)
    second, last_cursor = loop_item_service.list_my_work_page(
        test_db, test_user.id, limit=2, cursor=cursor
    )

    assert [row["id"] for row in first + second] == [row.id for row in reversed(rows)]
    assert last_cursor is None
    with pytest.raises(HTTPException, match="Invalid My Work cursor"):
        loop_item_service.list_my_work_page(test_db, other.id, cursor=cursor)


def test_empty_external_projection_still_advances_the_raw_row_cursor(
    test_db, test_user, monkeypatch
):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 2)
    rows[1].metadata_json = {"external_index": True}
    test_db.commit()
    requests = []

    def missing_provider_row(_db, project_id, user_id, item_ids):
        requests.append((project_id, user_id, item_ids))
        return []

    monkeypatch.setattr(external_loop_item_provider, "get_many", missing_provider_row)
    first, cursor = loop_item_service.list_my_work_page(test_db, test_user.id, limit=1)
    second, last_cursor = loop_item_service.list_my_work_page(
        test_db, test_user.id, limit=1, cursor=cursor
    )

    assert first == []
    assert cursor is not None
    assert [row["id"] for row in second] == [rows[0].id]
    assert last_cursor is None
    assert requests == [(str(project.id), test_user.id, [rows[1].id])]


def test_project_access_is_rechecked_after_a_cursor_was_issued(test_db, test_user):
    owner = User(user_name="pagination-owner", password_hash="unused", is_active=True)
    test_db.add(owner)
    test_db.commit()
    project = _make_project(test_db, owner)
    grant = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=int(project.id),
        entity_type="user",
        entity_id=str(test_user.id),
        role="Developer",
        status="approved",
    )
    test_db.add(grant)
    test_db.commit()
    add_items(test_db, project, test_user.id, 2)
    first, cursor = loop_item_service.list_my_work_page(test_db, test_user.id, limit=1)
    assert len(first) == 1
    assert cursor is not None
    test_db.delete(grant)
    test_db.commit()

    assert loop_item_service.list_my_work_page(
        test_db, test_user.id, cursor=cursor
    ) == ([], None)


@pytest.mark.parametrize("cursor", ["", "invalid!", "a", "e30", "x" * 2049])
def test_malformed_cursors_are_rejected(test_db, test_user, cursor):
    with pytest.raises(HTTPException) as failure:
        loop_item_service.list_my_work_page(test_db, test_user.id, cursor=cursor)
    assert failure.value.status_code == 400


def test_cursor_requires_a_canonical_naive_database_timestamp(test_db, test_user):
    payload = {
        "v": 1,
        "user_id": test_user.id,
        "updated_at": "2026-01-01T00:00:00+00:00",
        "id": "PAGE-1",
    }
    cursor = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    with pytest.raises(HTTPException) as failure:
        loop_item_service.list_my_work_page(test_db, test_user.id, cursor=cursor)
    assert failure.value.status_code == 400


def test_api_returns_and_accepts_opaque_next_cursor(
    test_client, test_db, test_user, test_token
):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 3)
    headers = {"Authorization": f"Bearer {test_token}"}
    first = test_client.get(
        "/api/v1/cloud-work-items/my-work", headers=headers, params={"limit": 2}
    )
    assert first.status_code == 200
    assert [row["id"] for row in first.json()["items"]] == [rows[2].id, rows[1].id]
    cursor = first.json()["next_cursor"]
    assert isinstance(cursor, str)
    second = test_client.get(
        "/api/v1/cloud-work-items/my-work",
        headers=headers,
        params={"limit": 2, "cursor": cursor},
    )
    assert second.status_code == 200
    assert [row["id"] for row in second.json()["items"]] == [rows[0].id]
    assert second.json()["next_cursor"] is None


def test_api_rejects_invalid_cursor(test_client, test_token):
    response = test_client.get(
        "/api/v1/cloud-work-items/my-work",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"cursor": "invalid!"},
    )
    assert response.status_code == 400


@pytest.mark.parametrize("attention", [False, True])
def test_my_work_batches_personal_bindings_and_assignment_comments(
    test_db, test_user, attention
):
    from uuid import uuid4

    from sqlalchemy import event

    from app.models.delivery import LoopItemTaskBinding
    from app.services.issue_assignments import issue_assignment_service

    project = _make_project(test_db, test_user)
    items = add_items(test_db, project, test_user.id, 5, prefix="BATCH")
    other = User(user_name="batch-other", password_hash="unused", is_active=True)
    test_db.add(other)
    test_db.flush()
    for item in items:
        item.assignee_user_id = test_user.id
        issue_assignment_service.record(
            test_db,
            project_id=project.id,
            issue_id=item.id,
            member_type="human",
            member_id=str(test_user.id),
            assigned_by_user_id=test_user.id,
            workflow_step=None,
            notify=False,
            trigger="manual",
            comment_body=f"Please handle {item.id}",
        )
        for owner in (test_user, other):
            test_db.add(
                LoopItemTaskBinding(
                    id=str(uuid4()),
                    cloud_project_id=str(project.id),
                    loop_item_id=item.id,
                    task_user_id=owner.id,
                    device_id="device",
                    task_id=f"{owner.id}-{item.id}",
                    linked_at=datetime(2026, 1, 1),
                    metadata_json={},
                )
            )
    test_db.commit()
    user_id = test_user.id
    loop_item_service.list_my_work_page(test_db, user_id, limit=1)
    counts = []
    for limit in (1, 5):
        statements = []

        def record_query(_conn, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)

        event.listen(test_db.bind, "before_cursor_execute", record_query)
        try:
            rows, _ = loop_item_service.list_my_work_page(
                test_db, user_id, limit=limit, attention=attention
            )
        finally:
            event.remove(test_db.bind, "before_cursor_execute", record_query)
        counts.append(len(statements))
        assert len(rows) == limit
        for row in rows:
            assert row["assignment_context"]["body"] == f"Please handle {row['id']}"
            assert (
                row["assignment_context"]["created_by_user_name"] == test_user.user_name
            )
            assert len(row["task_bindings"]) == 1
            assert row["task_bindings"][0].task_user_id == user_id
    assert counts[0] == counts[1], counts


def test_assigned_scope_and_completion_filter_are_applied_before_pagination(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 5, prefix="SCOPE")
    rows[0].assignee_user_id = test_user.id
    rows[1].assignee_user_id = test_user.id
    rows[1].status = "completed"
    test_db.commit()
    page, cursor = loop_item_service.list_my_work_page(
        test_db, test_user.id, limit=1, assigned_only=True, include_completed=False
    )
    assert [row["id"] for row in page] == [rows[0].id]
    assert cursor is None


def test_pending_issue_with_an_active_binding_is_not_ranked_as_unstarted(
    test_db, test_user
):
    from uuid import uuid4

    from app.models.delivery import LoopItemTaskBinding

    project = _make_project(test_db, test_user)
    items = add_items(test_db, project, test_user.id, 2, prefix="BOUND")
    for item in items:
        item.assignee_user_id = test_user.id
    test_db.add(
        LoopItemTaskBinding(
            id=str(uuid4()),
            cloud_project_id=project.id,
            loop_item_id=items[1].id,
            task_user_id=test_user.id,
            device_id="device",
            task_id="accepted-task",
            linked_at=datetime(2026, 1, 1),
            metadata_json={},
        )
    )
    test_db.commit()
    page, cursor = loop_item_service.list_my_work_page(
        test_db,
        test_user.id,
        limit=1,
        assigned_only=True,
        attention=True,
    )
    assert page[0]["id"] == items[0].id
    assert page[0]["attention_order"][0] == 1
    second, _ = loop_item_service.list_my_work_page(
        test_db,
        test_user.id,
        limit=1,
        assigned_only=True,
        attention=True,
        cursor=cursor,
    )
    assert second[0]["id"] == items[1].id
    assert second[0]["attention_order"][0] == 3


def test_attention_order_is_applied_before_pages_and_keeps_completed_last(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 6, prefix="ATTENTION")
    for row, status in zip(
        rows, ["in_review", "pending", "inbox", "in_progress", "blocked", "completed"]
    ):
        row.assignee_user_id = test_user.id
        row.status = status
    rows[1].priority = "high"
    rows[2].priority = "low"
    rows[5].priority = "urgent"
    test_db.commit()
    seen, cursor = [], None
    for _ in range(3):
        page, cursor = loop_item_service.list_my_work_page(
            test_db,
            test_user.id,
            limit=2,
            assigned_only=True,
            attention=True,
            cursor=cursor,
        )
        seen.extend(page)
    assert [row["id"] for row in seen] == [row.id for row in rows]
    assert [row["attention_order"][0] for row in seen] == [0, 1, 1, 2, 3, 4]
    assert cursor is None


def test_participating_attention_uses_comment_activity_and_personal_handoffs(
    test_db, test_user
):
    from app.models.delivery import LoopItemComment

    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 3, prefix="DISCUSSION")
    rows[2].priority = "urgent"
    test_db.flush()
    rows[2].updated_at = datetime(2026, 1, 1, 0, 2)
    test_db.add(
        LoopItemComment(
            id="recent-comment",
            loop_item_id=rows[0].id,
            cloud_project_id=project.id,
            description="Recent discussion",
            created_by_user_id=test_user.id,
            created_at=datetime(2026, 2, 1),
            metadata_json={},
        )
    )
    test_db.execute(
        LoopItem.__table__.insert().values(
            id="attention-question",
            resource_type="human_request_index",
            parent_id=rows[1].id,
            assignee_user_id=test_user.id,
            metadata={},
        )
    )
    test_db.commit()
    page, _ = loop_item_service.list_my_work_page(test_db, test_user.id, attention=True)
    assert [row["id"] for row in page] == [rows[1].id, rows[0].id, rows[2].id]
    assert [row["attention_order"][0] for row in page] == [0, 3, 3]
    assert page[1]["attention_order"][2].startswith("2026-02-01")


def test_attention_cursor_cannot_be_used_with_recent_order(test_db, test_user):
    project = _make_project(test_db, test_user)
    add_items(test_db, project, test_user.id, 2)
    _, cursor = loop_item_service.list_my_work_page(
        test_db, test_user.id, limit=1, attention=True
    )
    with pytest.raises(HTTPException) as failure:
        loop_item_service.list_my_work_page(test_db, test_user.id, cursor=cursor)
    assert failure.value.status_code == 400


@pytest.mark.parametrize(
    ("order", "expected"),
    [("assignment", [1, 0, 2]), ("activity", [2, 1, 0]), ("priority", [0, 2, 1])],
)
def test_personal_sort_modes_apply_before_every_page(
    test_db, test_user, order, expected
):
    from app.services.issue_assignments import issue_assignment_service

    project = _make_project(test_db, test_user)
    rows = add_items(test_db, project, test_user.id, 3, prefix="SORT")
    for index, row in enumerate(rows):
        row.assignee_user_id = test_user.id
        row.priority = ["urgent", "low", "high"][index]
        if index != 2:
            event, created = issue_assignment_service.record(
                test_db,
                project_id=project.id,
                issue_id=row.id,
                member_type="human",
                member_id=str(test_user.id),
                assigned_by_user_id=test_user.id,
                workflow_step=None,
                notify=False,
                trigger="manual",
                comment_body="Assignment",
            )
            assert created
            event.comment.created_at = datetime(2026, 1, 2 - index)
    test_db.flush()
    for index, row in enumerate(rows):
        row.updated_at = datetime(2026, 2, index + 1)
    test_db.commit()
    cursor, actual = None, []
    for _ in range(3):
        page, cursor = loop_item_service.list_my_work_page(
            test_db,
            test_user.id,
            order=order,
            assigned_only=True,
            limit=1,
            cursor=cursor,
        )
        actual.extend(row["id"] for row in page)
    assert actual == [rows[index].id for index in expected]
    assert cursor is None
