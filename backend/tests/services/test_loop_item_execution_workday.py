"""Persisted scheduled occurrences are checked again at actual queue/start boundaries."""

import json
from datetime import datetime
from unittest.mock import patch

import pytest

from app.models.delivery import ProjectAutomationRun
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_item_executions.workday import permits_execution_start
from tests.services.test_loop_item_executions import (
    _make_bot,
    _make_execution,
    _make_item,
    _make_project,
)


def scheduled_execution(db, user):
    project = _make_project(db, user)
    bot = _make_bot(db, project, user)
    issue = _make_item(db, project, user)
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=issue.id,
        title="Scheduled workday run",
        description="",
        status="queued",
        source="scheduled",
        created_by_user_id=user.id,
        metadata_json={"workday_only": True, "trigger": "scheduled"},
    )
    db.add(run)
    db.commit()
    execution = _make_execution(
        db, issue, bot, user, automation_context={"run_id": str(run.id)}
    )
    return execution, run, project, bot


def claim(db, user):
    return loop_item_execution_service.claim_next_for_device(
        db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=user.id,
        runtime_instance_id="runtime-1",
    )


def freeze_now(monkeypatch, value):
    monkeypatch.setattr(
        "app.services.loop_item_executions.service.utcnow",
        lambda: datetime.fromisoformat(value),
    )


def test_workday_claim_cancels_overdue_run_and_keeps_other_work_moving(
    test_db, test_user, monkeypatch
):
    execution, run, project, bot = scheduled_execution(test_db, test_user)
    ordinary = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    freeze_now(monkeypatch, "2026-10-01T01:00:00")
    claimed = claim(test_db, test_user)
    assert claimed.id == ordinary.id
    test_db.refresh(execution)
    test_db.refresh(run)
    assert execution.status == "cancelled"
    assert "not a China statutory workday" in execution.execution_note
    assert run.status == "cancelled"


def test_unknown_workday_calendar_preserves_queue_and_recovers_after_data_update(
    test_db, test_user, monkeypatch
):
    from shared.utils import workday

    execution, run, project, bot = scheduled_execution(test_db, test_user)
    ordinary = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    freeze_now(monkeypatch, "2100-01-01T01:00:00")
    assert claim(test_db, test_user).id == ordinary.id
    test_db.refresh(execution)
    test_db.refresh(run)
    assert execution.status == run.status == "queued"
    assert "does not cover 2100-01-01" in execution.error_message
    updated_calendar = {**workday._calendar(), "endDate": "2100-12-31"}
    monkeypatch.setattr(workday, "_calendar", lambda: updated_calendar)
    assert claim(test_db, test_user).id == execution.id


@pytest.mark.parametrize("trigger", ["manual", "event"])
def test_workday_policy_does_not_filter_explicit_or_event_runs(
    test_db, test_user, monkeypatch, trigger
):
    execution, run, _, _ = scheduled_execution(test_db, test_user)
    run.metadata_json = {"workday_only": True, "trigger": trigger}
    run.source = trigger
    test_db.commit()
    freeze_now(monkeypatch, "2026-10-01T01:00:00")
    assert claim(test_db, test_user).id == execution.id


@pytest.mark.parametrize("run_status", ["running", "succeeded", "failed"])
def test_workday_policy_preserves_live_or_completed_run_continuations(
    test_db, test_user, run_status
):
    execution, run, _, _ = scheduled_execution(test_db, test_user)
    run.status = run_status
    test_db.commit()
    assert permits_execution_start(test_db, execution, datetime(2026, 10, 1, 1))
    assert execution.status == "queued"


def test_workday_policy_excludes_comment_and_group_member_continuations(
    test_db, test_user
):
    execution, _, _, _ = scheduled_execution(test_db, test_user)
    payload = json.loads(execution.execution_payload)
    context = payload.setdefault("origin_context", {})
    context["comment_trigger_message_id"] = "human-comment"
    execution.execution_payload = json.dumps(payload)
    assert permits_execution_start(test_db, execution, datetime(2026, 10, 1, 1))
    del context["comment_trigger_message_id"]
    context["dispatch_kind"] = "collaboration_group"
    payload["runtime_selection"]["executor_kind"] = "project_robot"
    execution.execution_payload = json.dumps(payload)
    assert not execution.owns_automation_run
    assert permits_execution_start(test_db, execution, datetime(2026, 10, 1, 1))


def test_workday_gate_runs_after_device_and_collaboration_authority(test_db, test_user):
    execution, _, _, _ = scheduled_execution(test_db, test_user)
    with (
        patch(
            "app.services.collaboration_revocation.execution_authorized",
            return_value=False,
        ),
        patch(
            "app.services.loop_item_executions.workday.permits_execution_start"
        ) as guard,
    ):
        assert claim(test_db, test_user) is None
    guard.assert_not_called()
    test_db.refresh(execution)
    assert execution.status == "queued"


def test_workday_start_recheck_does_not_deliver_a_claim_after_midnight(
    test_db, test_user, monkeypatch
):
    execution, run, _, _ = scheduled_execution(test_db, test_user)
    freeze_now(monkeypatch, "2026-09-30T01:00:00")
    assert claim(test_db, test_user).id == execution.id
    freeze_now(monkeypatch, "2026-09-30T17:00:00")
    assert (
        loop_item_execution_service.mark_start_requested(
            test_db, execution_ids=[execution.id]
        )
        == 0
    )
    test_db.refresh(execution)
    test_db.refresh(run)
    assert execution.status == "cancelled"
    assert run.status == "cancelled"
