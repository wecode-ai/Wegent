# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Assignment deletion validates its resulting Issue owner before any write."""

from copy import deepcopy
from datetime import datetime, timedelta

import pytest

from app.api.endpoints import deliveries
from app.core.security import create_access_token
from app.models.delivery import LoopItemActiveAssignment, LoopItemComment
from app.models.loop_item_execution import LoopItemExecution
from app.models.wework_notification import WeworkNotification
from app.services.issue_assignments import issue_assignment_service
from tests.services.test_stage_assignees import stage_scenario  # noqa: F401


def _assignment(scenario, user_id, *, step, offset):
    assignment, _ = issue_assignment_service.record(
        scenario.db,
        project_id=int(scenario.project.id),
        issue_id=scenario.issue.id,
        member_type="human",
        member_id=str(user_id),
        assigned_by_user_id=scenario.owner.id,
        workflow_step=step,
        notify=False,
        trigger="test",
    )
    assignment.comment.created_at = datetime(2026, 11, 17) + timedelta(seconds=offset)
    scenario.db.flush()
    return assignment


def _snapshot(scenario):
    return (
        scenario.issue.version,
        scenario.issue.assignee_user_id,
        scenario.issue.assignee_agent_id,
        scenario.issue.assignee_team_id,
        deepcopy(scenario.issue.metadata_json),
        tuple(
            scenario.db.query(model).count()
            for model in (
                LoopItemComment,
                LoopItemActiveAssignment,
                LoopItemExecution,
                WeworkNotification,
            )
        ),
        [
            event.id
            for event in issue_assignment_service.active_for_issue(
                scenario.db, scenario.issue.id
            )
        ],
    )


@pytest.mark.parametrize("stage", ["proposal", "build"])
@pytest.mark.parametrize("historical_owner", [False, True])
def test_delete_cannot_clear_or_restore_a_forbidden_stage_owner(
    stage_scenario,
    test_admin_user,
    test_client,
    test_token,
    monkeypatch,
    stage,
    historical_owner,
):
    s = stage_scenario
    if stage == "proposal":
        s.owner.user_name = "jiangyang7"
        test_token = create_access_token(data={"sub": s.owner.user_name})
        s.issue.metadata_json = {
            "workflow": {
                "current_stage_id": "proposal",
                "nodes": [
                    {"id": "proposal", "name": "需求提出"},
                    {"id": "review", "name": "共同评审"},
                ],
            }
        }
    if historical_owner:
        _assignment(s, test_admin_user.id, step="historical-step", offset=0)
    assignment = _assignment(s, s.owner.id, step=None, offset=1)
    s.db.commit()
    before = _snapshot(s)
    published = []
    monkeypatch.setattr(
        deliveries, "publish_loop_item_changed", lambda *a, **kw: published.append(kw)
    )

    response = test_client.delete(
        f"/api/v1/loop-items/{s.issue.id}/assignments/{assignment.id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["reason_code"] == "stage_assignee_mismatch"
    assert detail["stage_id"] == stage
    assert detail["actual_assignee"] == {
        "assignee_type": "user",
        "assignee_id": str(test_admin_user.id) if historical_owner else None,
    }
    s.db.refresh(s.issue)
    assert _snapshot(s) == before
    assert published == []


@pytest.mark.parametrize("historical_owner", [False, True])
def test_unconstrained_delete_preserves_legacy_owner_projection(
    stage_scenario,
    test_admin_user,
    test_client,
    test_token,
    monkeypatch,
    historical_owner,
):
    s = stage_scenario
    s.issue.metadata_json = {}
    previous = (
        _assignment(s, test_admin_user.id, step="historical-step", offset=0)
        if historical_owner
        else None
    )
    assignment = _assignment(s, s.owner.id, step=None, offset=1)
    s.db.commit()
    version = s.issue.version
    published = []
    monkeypatch.setattr(
        deliveries, "publish_loop_item_changed", lambda *a, **kw: published.append(kw)
    )

    response = test_client.delete(
        f"/api/v1/loop-items/{s.issue.id}/assignments/{assignment.id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 204, response.text
    s.db.refresh(s.issue)
    assert s.issue.assignee_user_id == (
        test_admin_user.id if historical_owner else None
    )
    assert s.issue.version == version + 1
    assert [
        event.id
        for event in issue_assignment_service.active_for_issue(s.db, s.issue.id)
    ] == ([previous.id] if previous else [])
    assert len(published) == 1


def test_deleting_an_older_scope_keeps_the_matching_root_owner(
    stage_scenario, test_admin_user, test_client, test_token, monkeypatch
):
    s = stage_scenario
    older = _assignment(s, test_admin_user.id, step="historical-step", offset=0)
    current = _assignment(s, s.owner.id, step=None, offset=1)
    s.db.commit()
    monkeypatch.setattr(deliveries, "publish_loop_item_changed", lambda *a, **kw: None)

    response = test_client.delete(
        f"/api/v1/loop-items/{s.issue.id}/assignments/{older.id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 204, response.text
    s.db.refresh(s.issue)
    assert s.issue.assignee_user_id == s.owner.id
    assert [
        event.id
        for event in issue_assignment_service.active_for_issue(s.db, s.issue.id)
    ] == [current.id]
