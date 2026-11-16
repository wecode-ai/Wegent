"""The processing actor is the observed execution, not the Issue assignee."""

import re
from datetime import datetime

import pytest
from sqlalchemy import event

from app.models.delivery import CloudProject
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.delivery import LoopItemResponse
from app.services.loop_items.service import loop_item_service
from tests.services.test_loop_item_assignment import (
    _make_bot,
    _make_item,
    _make_project,
)


@pytest.fixture
def unassigned_execution(test_db, test_user):
    project = _make_project(test_db, test_user)
    agent = _make_bot(test_db, project, test_user)
    agent.title = "Mentioned runtime bot"
    item = _make_item(test_db, project, test_user)
    item.sequence_number = 1
    item.priority = "none"
    assert not item.assignee_agent_id
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=project.id,
        agent_id=agent.id,
        executor_owner_user_id=test_user.id,
        status="running",
        observed_state="running",
        sync_state="in_sync",
    )
    test_db.add(execution)
    test_db.commit()
    return item, execution


def test_unassigned_comment_run_exposes_actual_actor_in_detail_and_my_work(
    test_db, test_user, unassigned_execution
):
    item, _ = unassigned_execution
    detail = loop_item_service.response_values(test_db, item, test_user.id)
    expected = {"kind": "agent", "name": "Mentioned runtime bot"}
    assert detail["processing_actor"] == expected
    assert not detail.get("assignee_agent_id")
    rows = loop_item_service.list_my_work(test_db, test_user.id)
    assert (
        next(row for row in rows if row["id"] == item.id)["processing_actor"]
        == expected
    )


@pytest.mark.parametrize(
    "status,observed,sync",
    [
        ("queued", "unconfirmed", "pending"),
        ("claimed", "unconfirmed", "in_sync"),
        ("running", "running", "stale"),
        ("completed", "succeeded", "in_sync"),
        ("failed", "failed", "in_sync"),
    ],
)
def test_nonrunning_or_uncertain_execution_does_not_claim_ai_actor(
    test_db, test_user, unassigned_execution, status, observed, sync
):
    item, execution = unassigned_execution
    execution.status, execution.observed_state, execution.sync_state = (
        status,
        observed,
        sync,
    )
    test_db.commit()
    assert (
        loop_item_service.response_values(test_db, item, test_user.id)[
            "processing_actor"
        ]
        is None
    )
    assert (
        next(
            row
            for row in loop_item_service.list_my_work(test_db, test_user.id)
            if row["id"] == item.id
        )["processing_actor"]
        is None
    )


def test_my_work_actor_resources_are_loaded_in_a_batch(
    test_db, test_user, unassigned_execution
):
    item, _ = unassigned_execution
    project = test_db.get(CloudProject, item.cloud_project_id)
    for _ in range(3):
        agent = _make_bot(test_db, project, test_user)
        another = _make_item(test_db, project, test_user)
        test_db.add(
            LoopItemExecution(
                loop_item_id=another.id,
                cloud_project_id=project.id,
                agent_id=agent.id,
                executor_owner_user_id=test_user.id,
                status="running",
                observed_state="running",
                sync_state="in_sync",
            )
        )
    test_db.commit()
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    bind = test_db.get_bind()
    test_db.expire_all()
    event.listen(bind, "before_cursor_execute", capture)
    try:
        rows = loop_item_service.list_my_work(test_db, test_user.id)
    finally:
        event.remove(bind, "before_cursor_execute", capture)
    assert sum(bool(row["processing_actor"]) for row in rows) == 4
    agent_reads = [
        sql
        for sql in statements
        if "FROM loop_items" in sql and re.search(r"WHERE\s+loop_items\.id IN", sql)
    ]
    assert len(agent_reads) == 1


def test_current_terminal_handoff_uses_explicit_utc_without_changing_legacy_ai_dates(
    test_db, test_user, unassigned_execution
):
    item, execution = unassigned_execution
    execution.status = "completed"
    execution.completed_at = datetime(2026, 11, 8, 1, 2, 3)
    test_db.commit()
    detail = loop_item_service.response_values(test_db, item, test_user.id)
    expected = "2026-11-08T01:02:03+00:00"
    assert detail["human_waiting_since"] == expected
    assert LoopItemResponse.model_validate(detail).human_waiting_since == expected
    assert detail["ai_state"]["completed_at"] == "2026-11-08T01:02:03"
    assert (
        next(
            row
            for row in loop_item_service.list_my_work(test_db, test_user.id)
            if row["id"] == item.id
        )["human_waiting_since"]
        == expected
    )
    newer = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=execution.cloud_project_id,
        agent_id=execution.agent_id,
        executor_owner_user_id=test_user.id,
        status="queued",
    )
    test_db.add(newer)
    test_db.commit()
    assert (
        loop_item_service.response_values(test_db, item, test_user.id)[
            "human_waiting_since"
        ]
        is None
    )
    assert (
        next(
            row
            for row in loop_item_service.list_my_work(test_db, test_user.id)
            if row["id"] == item.id
        )["human_waiting_since"]
        is None
    )
