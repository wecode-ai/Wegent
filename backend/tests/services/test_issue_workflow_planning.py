# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contracts for versioned AI Issue plans and child-task materialization."""

import uuid

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    ProjectWorkflowPlanItem,
    ProjectWorkflowRun,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.issue_workflow import (
    WorkflowPlanItemView,
    WorkflowPlanSubmit,
    WorkflowTaskOutcomeSubmit,
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


def _robot(db: Session, project: CloudProject, user: User) -> ProjectChatAgent:
    device_id = f"local-{uuid.uuid4().hex[:10]}"
    db.add(
        Kind(
            kind="Device",
            name=device_id,
            namespace="default",
            user_id=user.id,
            is_active=True,
            json={"spec": {"deviceType": "local"}},
        )
    )
    robot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Developer robot",
        name="Developer robot",
        status="active",
        created_by_user_id=user.id,
        device_id=device_id,
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "execution_mode": "auto",
            "execution_environment": "local",
            "visibility": "public",
        },
    )
    db.add(robot)
    db.commit()
    db.refresh(robot)
    return robot


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


def _plan(robot: ProjectChatAgent) -> WorkflowPlanSubmit:
    return WorkflowPlanSubmit.model_validate(
        {
            "summary": "Implement, then verify.",
            "items": [
                {
                    "client_key": "implement",
                    "stage_id": "__issue__",
                    "title": "Implement feature",
                    "description": "Create the implementation and tests.",
                    "assignee_type": "agent",
                    "assignee_id": robot.id,
                    "assignee_name": robot.name,
                    "rationale": "Development capability matches the task.",
                }
            ],
        }
    )


def test_submit_creates_and_preserves_active_run_snapshot(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)

    view = issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )

    test_db.refresh(issue)
    workflow = issue.metadata_json["workflow"]
    assert workflow["active_run_id"] == view.run_id
    assert workflow["active_plan_version"] == view.plan_version
    assert workflow["orchestration_status"] == "awaiting_approval"
    restored = issue_workflow_planning_service.get(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    assert restored is not None
    assert restored.run_id == view.run_id


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


def test_required_plan_materializes_once_after_approval(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    run = issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    run.metadata_json = {
        **(run.metadata_json or {}),
        "project_automation_run_id": "automation-run-1",
    }
    test_db.commit()

    proposed = issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )

    assert proposed.run_id == run.id
    assert proposed.status == "awaiting_approval"
    assert proposed.items[0].task_id is None
    assert test_db.query(LoopItem).filter(LoopItem.parent_id == issue.id).count() == 0

    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    repeated = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert approved.status == "running"
    assert repeated.items[0].task_id == approved.items[0].task_id
    children = test_db.query(LoopItem).filter(LoopItem.parent_id == issue.id).all()
    assert len(children) == 1
    child = children[0]
    assert child.assignee_agent_id == robot.id
    assert child.status == "pending"
    assert child.metadata_json["workflow_plan"]["client_key"] == "implement"
    assert child.metadata_json.get("workflow") is None
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == child.id)
        .one()
    )
    assert execution.agent_id == robot.id
    assert execution.status == "queued"
    assert execution.automation_run_id == "automation-run-1"


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


def test_replan_keeps_materialized_history_and_increments_version(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    test_db.commit()
    first = issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )
    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    replanned = issue_workflow_planning_service.replan(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert replanned.run_id != first.run_id
    assert replanned.plan_version == first.plan_version + 1
    assert replanned.status == "planning"
    assert approved.items[0].task_id is not None
    child = test_db.get(LoopItem, approved.items[0].task_id)
    assert child is not None
    assert child.parent_id == issue.id
    old_run = test_db.get(ProjectWorkflowRun, first.run_id)
    assert old_run is not None
    assert old_run.status == "failed"
    old_item = (
        test_db.query(ProjectWorkflowPlanItem)
        .filter(ProjectWorkflowPlanItem.parent_id == first.run_id)
        .one()
    )
    assert old_item.status == "materialized"


def test_rejects_inactive_robot_before_persisting_plan(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    test_db.commit()
    robot.status = "archived"
    test_db.commit()

    try:
        issue_workflow_planning_service.submit(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            values=_plan(robot),
        )
    except ValueError as exc:
        assert str(exc) == "Workflow plan selected an unavailable robot"
    else:
        raise AssertionError("inactive robot must be rejected")

    assert test_db.query(ProjectWorkflowPlanItem).count() == 0


def test_child_outcome_projects_to_one_parent_review(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    test_db.commit()
    issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )
    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    child_id = approved.items[0].task_id
    assert child_id is not None

    review = issue_workflow_planning_service.report_outcome(
        test_db,
        child_id=child_id,
        user_id=test_user.id,
        values=WorkflowTaskOutcomeSubmit(
            verdict="passed",
            summary="Implementation and tests passed.",
        ),
    )

    assert review.status == "awaiting_review"
    assert review.items[0].outcome_verdict == "passed"
    assert review.items[0].outcome_summary == "Implementation and tests passed."
    assert test_db.get(LoopItem, child_id).status == "in_review"
    assert test_db.get(LoopItem, issue.id).status == "in_review"

    completed = issue_workflow_planning_service.approve_review(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert completed.status == "completed"
    assert test_db.get(LoopItem, child_id).status == "completed"
    assert test_db.get(LoopItem, issue.id).status == "completed"


def test_needs_rework_stops_old_task_and_starts_new_plan_version(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    test_db.commit()
    issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )
    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    child_id = approved.items[0].task_id
    assert child_id is not None
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == child_id)
        .one()
    )

    replanned = issue_workflow_planning_service.report_outcome(
        test_db,
        child_id=child_id,
        user_id=test_user.id,
        values=WorkflowTaskOutcomeSubmit(
            verdict="needs_rework",
            summary="The edge-case test failed.",
            findings=["Duplicate values are ordered incorrectly."],
        ),
    )

    assert replanned.status == "planning"
    assert replanned.plan_version == approved.plan_version + 1
    old_child = test_db.get(LoopItem, child_id)
    assert old_child.status == "completed"
    assert old_child.metadata_json["workflow_plan"]["superseded"] is True
    test_db.refresh(execution)
    assert execution.status == "cancelled"


def test_pause_stops_unfinished_task_and_resume_creates_one_new_attempt(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    test_db.commit()
    issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )
    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    child_id = approved.items[0].task_id
    assert child_id is not None
    first_execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == child_id)
        .one()
    )

    paused = issue_workflow_planning_service.pause(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert paused.status == "paused"
    test_db.refresh(first_execution)
    assert first_execution.status == "cancelled"
    assert test_db.get(LoopItem, child_id).status == "pending"

    resumed = issue_workflow_planning_service.resume(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    repeated = issue_workflow_planning_service.resume(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert resumed.status == "running"
    assert repeated.status == "running"
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == child_id)
        .order_by(LoopItemExecution.id)
        .all()
    )
    assert len(executions) == 2
    assert executions[0].status == "cancelled"
    assert executions[1].status == "queued"


def test_completed_workflow_can_run_again_without_rewriting_history(
    test_db: Session,
    test_user: User,
) -> None:
    project = _project(test_db, test_user)
    robot = _robot(test_db, project, test_user)
    issue = _issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    test_db.commit()
    issue_workflow_planning_service.submit(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=_plan(robot),
    )
    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    child_id = approved.items[0].task_id
    assert child_id is not None
    issue_workflow_planning_service.report_outcome(
        test_db,
        child_id=child_id,
        user_id=test_user.id,
        values=WorkflowTaskOutcomeSubmit(
            verdict="passed",
            summary="Implementation and tests passed.",
        ),
    )
    completed = issue_workflow_planning_service.approve_review(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    restarted = issue_workflow_planning_service.replan(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )

    assert restarted.status == "planning"
    assert restarted.plan_version == completed.plan_version + 1
    test_db.refresh(issue)
    assert issue.status == "pending"
    assert issue.completed_at is None
    previous_run = test_db.get(ProjectWorkflowRun, completed.run_id)
    assert previous_run is not None
    assert previous_run.status == "completed"
    previous_child = test_db.get(LoopItem, child_id)
    assert previous_child is not None
    assert previous_child.status == "completed"
    assert previous_child.metadata_json["workflow_plan"].get("superseded") is not True
