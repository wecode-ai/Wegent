# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.delivery import IssueDispatch, IssueDispatchRound, IssueDispatchTask
from app.services.issue_dispatch_domain import (
    DispatchConflict,
    direct_outcome,
    evaluate_round_barrier,
    prepare_next_round,
    require_stage_for_group_task,
)
from app.services.issue_dispatch_state_machine import IssueDispatchStateMachine


def test_round_barrier_waits_for_every_concurrent_task() -> None:
    barrier = evaluate_round_barrier(["submitted", "running", "failed"])

    assert barrier.round_status == "executing"
    assert barrier.request_leader_turn is False


def test_round_barrier_returns_control_to_leader_when_all_tasks_finish() -> None:
    barrier = evaluate_round_barrier(["submitted", "failed", "cancelled"])

    assert barrier.round_status == "evaluating"
    assert barrier.request_leader_turn is True


def test_manager_can_start_next_round_after_evaluation() -> None:
    assert prepare_next_round("evaluating") is True
    assert prepare_next_round(None) is False

    with pytest.raises(DispatchConflict):
        prepare_next_round("executing")


def test_direct_success_enters_review_but_failure_does_not_move_issue() -> None:
    success = direct_outcome("submitted")
    failure = direct_outcome("failed")

    assert success.dispatch_status == "completed"
    assert success.issue_status == "in_review"
    assert failure.dispatch_status == "active"
    assert failure.issue_status is None


def test_project_stage_is_required_only_when_configured() -> None:
    require_stage_for_group_task(set(), None)
    require_stage_for_group_task({"collect", "review"}, "collect")

    with pytest.raises(DispatchConflict):
        require_stage_for_group_task({"collect"}, None)
    with pytest.raises(DispatchConflict):
        require_stage_for_group_task({"collect"}, "unknown")


def test_aggregate_state_machine_owns_task_round_and_dispatch_transitions() -> None:
    state_machine = IssueDispatchStateMachine()
    dispatch = IssueDispatch(
        id="dispatch-1", status="active", metadata_json={}, version=1
    )
    round_record = IssueDispatchRound(id="round-1", status="planning", version=1)
    task = IssueDispatchTask(id="task-1", status="queued", version=1)

    state_machine.begin_round(round_record, dispatch)
    state_machine.finish_task(
        task,
        status="submitted",
        summary="Verified.",
        delivery_id=None,
    )
    state_machine.apply_round_barrier(round_record, status="evaluating")
    state_machine.close_round(round_record)
    state_machine.complete_dispatch(dispatch)

    assert task.status == "submitted"
    assert round_record.status == "closed"
    assert dispatch.status == "completed"
    assert dispatch.metadata_json["active_round_id"] is None

    state_machine.return_task_for_rework(task, reason="More evidence required.")
    assert state_machine.reopen_dispatch(dispatch) is True
    assert task.status == "needs_rework"
    assert dispatch.status == "active"


def test_aggregate_state_machine_rejects_illegal_transitions() -> None:
    state_machine = IssueDispatchStateMachine()
    dispatch = IssueDispatch(id="dispatch-1", status="cancelled")
    round_record = IssueDispatchRound(id="round-1", status="executing")
    task = IssueDispatchTask(id="task-1", status="submitted")

    with pytest.raises(DispatchConflict):
        state_machine.finish_task(
            task,
            status="failed",
            summary="Duplicate result.",
            delivery_id=None,
        )
    with pytest.raises(DispatchConflict):
        state_machine.close_round(round_record)
    with pytest.raises(DispatchConflict):
        state_machine.complete_dispatch(dispatch)
