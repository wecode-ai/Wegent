# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, ProjectAutomationRun, ProjectWorkflowRun
from app.models.user import User
from app.services.project_workflow_projection import (
    sync_automation_workflow_node,
    update_workflow_node,
)


@pytest.fixture
def workflow_project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="WORKFLOW",
        name="Workflow project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def test_workflow_projection_unlocks_dependencies_and_updates_issue_status(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="workflow-projection-item",
        cloud_project_id=workflow_project.id,
        sequence_number=99,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Workflow projection",
        description="",
        status="pending",
        priority="none",
        sort_order=0,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "nodes": [
                    {
                        "id": "develop",
                        "name": "Develop",
                        "kind": "my_task",
                        "depends_on": [],
                        "required": True,
                        "workspace_policy": "composer",
                        "status": "running",
                    },
                    {
                        "id": "test",
                        "name": "Test",
                        "kind": "my_task",
                        "depends_on": ["develop"],
                        "required": True,
                        "workspace_policy": "inherit",
                        "status": "blocked",
                    },
                ],
            }
        },
    )
    test_db.add(item)
    test_db.commit()

    updated = update_workflow_node(
        test_db,
        item_id=item.id,
        node_id="develop",
        node_status="completed",
    )
    test_db.commit()

    assert updated is not None
    assert [node["status"] for node in updated.metadata_json["workflow"]["nodes"]] == [
        "completed",
        "ready",
    ]
    assert updated.status == "pending"

    update_workflow_node(
        test_db,
        item_id=item.id,
        node_id="test",
        node_status="running",
    )
    test_db.commit()
    assert item.status == "in_progress"

    update_workflow_node(
        test_db,
        item_id=item.id,
        node_id="test",
        node_status="completed",
    )
    test_db.commit()
    assert item.status == "in_review"


def test_terminal_coordinator_without_a_plan_marks_planning_failed(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    issue = LoopItem(
        id="workflow-coordinator-issue",
        cloud_project_id=workflow_project.id,
        sequence_number=100,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Coordinator failure",
        description="",
        status="pending",
        priority="none",
        sort_order=0,
    )
    planning_run = ProjectWorkflowRun(
        id="workflow-planning-run",
        cloud_project_id=workflow_project.id,
        parent_id=issue.id,
        title="Plan",
        status="planning",
        created_by_user_id=workflow_project.created_by_user_id,
    )
    issue.metadata_json = {
        "workflow": {
            "version": 1,
            "definition_version": 1,
            "stage_mode": "none",
            "advancement_policy": "ai",
            "ai_automation_rule_id": "coordinator-rule",
            "orchestration_status": "planning",
            "active_run_id": planning_run.id,
            "active_plan_version": 1,
            "nodes": [],
        }
    }
    coordinator_run = ProjectAutomationRun(
        id="workflow-coordinator-run",
        cloud_project_id=workflow_project.id,
        parent_id="coordinator-rule",
        task_id=issue.id,
        title="Coordinate",
        status="failed",
        created_by_user_id=workflow_project.created_by_user_id,
        metadata_json={
            "event": {
                "payload": {
                    "workflow": {
                        "advancement_policy": "ai",
                    }
                }
            }
        },
    )
    test_db.add_all([issue, planning_run, coordinator_run])
    test_db.commit()

    updated = sync_automation_workflow_node(test_db, coordinator_run)
    test_db.commit()

    assert updated is not None
    assert updated.metadata_json["workflow"]["orchestration_status"] == "failed"
    assert planning_run.status == "failed"
