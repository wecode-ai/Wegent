# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contracts for coordinator turns and read-only historical plans."""

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectWorkflowPlanItem,
)
from app.models.user import User
from app.schemas.issue_workflow import (
    WorkflowPlanItemView,
)
from app.services.issue_workflow_planning import issue_workflow_planning_service


def _project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"PLAN{uuid.uuid4().hex[:6].upper()}",
        name="Planning project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _issue(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    approval_policy: str = "required",
) -> LoopItem:
    issue = LoopItem(
        id=f"I{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Implement feature",
        description="Build and verify the feature",
        status="pending",
        priority="medium",
        created_by_user_id=user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "none",
                "advancement_policy": "ai",
                "coordinator_prompt": "",
                "approval_policy": approval_policy,
                "ai_automation_rule_id": "rule-1",
                "orchestration_status": "idle",
                "nodes": [],
            }
        },
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)
    return issue


def test_plan_item_view_accepts_configurable_board_status() -> None:
    item = WorkflowPlanItemView.model_validate(
        {
            "id": "plan-item-1",
            "client_key": "implement",
            "stage_id": "__issue__",
            "title": "Implement",
            "description": "",
            "assignee_type": "user",
            "assignee_id": "7",
            "task_status": "custom_validation",
            "status": "materialized",
        }
    )

    assert item.task_status == "custom_validation"


def test_plan_view_projects_manager_runtime(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    workflow_run = issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    rule = ProjectAutomationRule(
        id="rule-1",
        cloud_project_id=project.id,
        title="AI manager",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "model": "deepseek-test",
            "execution_environment": "cloud",
            "execution_device_id": "cloud-device-1",
        },
    )
    automation_run = ProjectAutomationRun(
        id=f"A{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=issue.id,
        title="AI manager run",
        status="running",
        created_by_user_id=test_user.id,
        device_id="cloud-device-1",
        metadata_json={"event": {"payload": {"workflow_run_id": workflow_run.id}}},
    )
    test_db.add_all([rule, automation_run])
    test_db.flush()
    workflow_run.metadata_json = {
        **workflow_run.metadata_json,
        "project_automation_run_id": str(automation_run.id),
    }
    test_db.commit()

    view = issue_workflow_planning_service.get(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert view is not None
    assert view.manager_run is not None
    assert view.manager_run.id == automation_run.id
    assert view.manager_run.model == "deepseek-test"
    assert view.manager_run.device_id == "cloud-device-1"
    assert view.manager_run.recent_activity == "正在读取 Issue 并生成编排方案"


def test_coordinator_turn_is_reused_without_materializing_children(test_db, test_user):
    issue = _issue(test_db, _project(test_db, test_user), test_user)
    first = issue_workflow_planning_service.ensure_run(
        test_db, issue=issue, user_id=test_user.id
    )
    second = issue_workflow_planning_service.ensure_run(
        test_db, issue=issue, user_id=test_user.id
    )
    assert first.id == second.id
    assert test_db.query(LoopItem).filter(LoopItem.parent_id == issue.id).count() == 0
    assert test_db.query(ProjectWorkflowPlanItem).count() == 0


def test_pause_preserves_current_work_and_resume_returns_to_coordinator(
    test_db, test_user
):
    issue = _issue(test_db, _project(test_db, test_user), test_user)
    first = issue_workflow_planning_service.ensure_run(
        test_db, issue=issue, user_id=test_user.id
    )
    first_id = first.id
    workflow = dict(issue.metadata_json["workflow"])
    workflow.update(intent="Stable requirements", current_work="Verify release")
    workflow["nodes"] = [
        {
            "id": "design",
            "name": "Design",
            "execution_mode": "robot",
            "status": "failed",
            "execution_error": "cancelled",
            "depends_on": [],
            "task_ids": ["device:task"],
            "task_statuses": {"device:task": "succeeded"},
        }
    ]
    issue.metadata_json = {"workflow": workflow}
    test_db.commit()
    issue_workflow_planning_service.pause(
        test_db, issue_id=issue.id, user_id=test_user.id
    )
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
    next_turn = issue_workflow_planning_service.resume(
        test_db, issue_id=issue.id, user_id=test_user.id
    )
    assert next_turn.run_id != first_id
    assert issue.metadata_json["workflow"]["intent"] == "Stable requirements"
    assert issue.metadata_json["workflow"]["current_work"] == "Verify release"
    assert issue.metadata_json["workflow"]["nodes"][0]["status"] == "completed"
    assert issue.metadata_json["workflow"]["nodes"][0]["execution_error"] is None
    assert test_db.query(LoopItem).filter(LoopItem.parent_id == issue.id).count() == 0


def test_replan_cannot_reopen_completed_automation(test_db, test_user):
    issue = _issue(test_db, _project(test_db, test_user), test_user)
    workflow = dict(issue.metadata_json["workflow"])
    workflow["orchestration_status"] = "completed"
    issue.metadata_json = {"workflow": workflow}
    test_db.commit()
    with pytest.raises(ValueError, match="Resume"):
        issue_workflow_planning_service.replan(
            test_db, issue_id=issue.id, user_id=test_user.id
        )


@pytest.mark.parametrize("action", ["ensure_run", "pause", "resume", "replan"])
def test_coordinator_actions_require_explicit_legacy_adoption(
    test_db, test_user, action
):
    issue = _issue(test_db, _project(test_db, test_user), test_user)
    workflow = dict(issue.metadata_json["workflow"])
    workflow.update(migration_required=True, orchestration_status="paused")
    issue.metadata_json = {"workflow": workflow}
    test_db.commit()

    kwargs = {"issue": issue} if action == "ensure_run" else {"issue_id": issue.id}
    with pytest.raises(ValueError, match="reviewed experience"):
        getattr(issue_workflow_planning_service, action)(
            test_db, user_id=test_user.id, **kwargs
        )

    assert issue.metadata_json["workflow"] == workflow
