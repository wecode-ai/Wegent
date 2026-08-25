# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, LoopItemTaskBinding
from app.models.user import User
from app.services.delivery import delivery_service
from app.services.project_workflow_projection import (
    update_workflow_node,
    update_workflow_task_status,
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
        node_status="failed",
        execution_error="Runtime model is unavailable",
    )
    test_db.commit()
    failed_node = item.metadata_json["workflow"]["nodes"][1]
    assert failed_node["execution_error"] == "Runtime model is unavailable"

    update_workflow_node(
        test_db,
        item_id=item.id,
        node_id="test",
        node_status="running",
    )
    test_db.commit()
    assert "execution_error" not in item.metadata_json["workflow"]["nodes"][1]
    assert item.status == "in_progress"

    update_workflow_node(
        test_db,
        item_id=item.id,
        node_id="test",
        node_status="completed",
    )
    test_db.commit()
    assert item.status == "in_review"


def test_direct_robot_task_succeeds_without_automation_rule(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="direct-robot-workflow-item",
        cloud_project_id=workflow_project.id,
        sequence_number=100,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Direct robot workflow",
        description="",
        status="in_progress",
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
                        "execution_mode": "robot",
                        "automation_rule_id": None,
                        "depends_on": [],
                        "required": True,
                        "status": "running",
                    }
                ],
            }
        },
    )
    binding = LoopItemTaskBinding(
        cloud_project_id=str(workflow_project.id),
        loop_item_id=item.id,
        task_user_id=workflow_project.created_by_user_id,
        device_id="local-device",
        task_id="direct-task",
        linked_by_user_id=workflow_project.created_by_user_id,
        metadata_json={"workflow_node_id": "develop"},
    )
    test_db.add_all([item, binding])
    test_db.commit()

    updated = update_workflow_task_status(
        test_db,
        user_id=workflow_project.created_by_user_id,
        device_id="local-device",
        task_id="direct-task",
        execution_status="succeeded",
    )

    assert updated is not None
    node = updated.metadata_json["workflow"]["nodes"][0]
    assert node["status"] == "completed"
    assert node["task_statuses"]["local-device:direct-task"] == "succeeded"
    assert updated.status == "in_review"


def test_direct_robot_delivery_does_not_complete_before_runtime_success(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="direct-robot-delivery-item",
        cloud_project_id=workflow_project.id,
        sequence_number=101,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Direct robot delivery",
        description="",
        status="in_progress",
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
                        "execution_mode": "robot",
                        "automation_rule_id": None,
                        "depends_on": [],
                        "required": True,
                        "status": "ready",
                    },
                    {
                        "id": "test",
                        "name": "Test",
                        "execution_mode": "human",
                        "depends_on": ["develop"],
                        "required": True,
                        "status": "blocked",
                    },
                ],
            }
        },
    )
    test_db.add(item)
    test_db.flush()

    delivery_service._complete_automated_node_if_fulfilled(
        test_db,
        item,
        "develop",
    )

    nodes = item.metadata_json["workflow"]["nodes"]
    assert [node["status"] for node in nodes] == ["ready", "blocked"]
    assert item.status == "in_progress"


def test_direct_robot_delivery_completes_after_runtime_success(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="direct-robot-delivery-after-runtime-item",
        cloud_project_id=workflow_project.id,
        sequence_number=102,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Direct robot delivery after runtime",
        description="",
        status="in_progress",
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
                        "execution_mode": "robot",
                        "automation_rule_id": None,
                        "depends_on": [],
                        "required": True,
                        "status": "awaiting_deliverables",
                    },
                    {
                        "id": "test",
                        "name": "Test",
                        "execution_mode": "human",
                        "depends_on": ["develop"],
                        "required": True,
                        "status": "blocked",
                    },
                ],
            }
        },
    )
    test_db.add(item)
    test_db.flush()

    delivery_service._complete_automated_node_if_fulfilled(
        test_db,
        item,
        "develop",
    )

    nodes = item.metadata_json["workflow"]["nodes"]
    assert [node["status"] for node in nodes] == ["completed", "ready"]
    assert item.status == "pending"
