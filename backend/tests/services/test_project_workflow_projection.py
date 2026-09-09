# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import (
    Delivery,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRun,
)
from app.models.kind import Kind
from app.models.user import User
from app.services.delivery import delivery_service
from app.services.loop_item_executions.service import runtime_device_identity_ids
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


def test_workflow_projection_updates_owning_automation_run(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="automation-rule",
        task_id="workflow-owned-item",
        task_title="Workflow owned item",
        source="event",
        status="running",
        created_by_user_id=workflow_project.created_by_user_id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.flush()
    item = LoopItem(
        id="workflow-owned-item",
        cloud_project_id=workflow_project.id,
        sequence_number=103,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Workflow owned item",
        description="",
        status="in_progress",
        priority="none",
        sort_order=0,
        metadata_json={
            "workflow_automation": {
                "rule_id": "automation-rule",
                "run_id": run.id,
            },
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "nodes": [
                    {
                        "id": "develop",
                        "name": "Develop",
                        "execution_mode": "robot",
                        "depends_on": [],
                        "required": True,
                        "status": "running",
                    }
                ],
            },
        },
    )
    test_db.add(item)
    test_db.commit()

    update_workflow_node(
        test_db,
        item_id=item.id,
        node_id="develop",
        node_status="completed",
    )
    test_db.commit()

    test_db.refresh(run)
    assert run.status == "succeeded"
    assert run.completed_at is not None


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
    assert item.status == "in_progress"


def test_direct_robot_delivery_derived_from_binding_when_node_link_is_missing(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="direct-robot-delivery-derived-item",
        cloud_project_id=workflow_project.id,
        sequence_number=103,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Direct robot delivery derived from binding",
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
                        "delivery_ids": [],
                        "required_deliverables": [
                            {
                                "id": "req-1",
                                "name": "MR",
                                "value_type": "pull_request",
                            }
                        ],
                    }
                ],
            }
        },
    )
    test_db.add(item)
    test_db.flush()
    binding = LoopItemTaskBinding(
        cloud_project_id=str(workflow_project.id),
        loop_item_id=item.id,
        task_user_id=workflow_project.created_by_user_id,
        device_id="local-device",
        task_id="derived-task",
        linked_by_user_id=workflow_project.created_by_user_id,
        metadata_json={"workflow_node_id": "develop"},
    )
    test_db.add(binding)
    test_db.flush()
    delivery = Delivery(
        cloud_project_id=str(workflow_project.id),
        loop_item_id=item.id,
        status="delivered",
        created_by_user_id=workflow_project.created_by_user_id,
        source_task_binding_id=str(binding.id),
        source_task_snapshot={"taskId": "derived-task"},
        metadata_json={
            "fulfillments": [
                {
                    "requirement_id": "req-1",
                    "kind": "pull_request",
                    "provider": "gitlab",
                    "url": "https://gitlab.example/repo/-/merge_requests/1",
                    "number": 1,
                    "state": "draft",
                    "head_branch": "feat/x",
                    "base_branch": "main",
                    "head_commit": "abc1234",
                }
            ]
        },
    )
    test_db.add(delivery)
    test_db.commit()
    test_db.refresh(item)

    delivery_service._complete_automated_node_if_fulfilled(
        test_db,
        item,
        "develop",
    )

    nodes = item.metadata_json["workflow"]["nodes"]
    assert nodes[0]["status"] == "completed"
    assert nodes[0]["delivery_ids"] == []


def test_runtime_device_identity_ids_resolve_executor_and_app_ids(
    test_db: Session,
    test_user: User,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="executor-dev",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceId": "executor-dev",
                    "appDeviceId": "app-device-1",
                }
            },
        )
    )
    test_db.commit()

    assert runtime_device_identity_ids(
        test_db,
        "executor-dev",
        owner_user_id=test_user.id,
    ) == [
        "executor-dev",
        "app-device-1",
    ]


def test_workflow_projection_matches_binding_through_device_identity(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="executor-dev",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceId": "executor-dev",
                    "appDeviceId": "app-device-1",
                }
            },
        )
    )
    item = LoopItem(
        id="device-identity-workflow-item",
        cloud_project_id=workflow_project.id,
        sequence_number=104,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Device identity workflow",
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
        device_id="app-device-1",
        task_id="identity-task",
        linked_by_user_id=workflow_project.created_by_user_id,
        metadata_json={"workflow_node_id": "develop"},
    )
    test_db.add_all([item, binding])
    test_db.commit()

    updated = update_workflow_task_status(
        test_db,
        user_id=workflow_project.created_by_user_id,
        device_id="executor-dev",
        task_id="identity-task",
        execution_status="succeeded",
    )

    assert updated is not None
    node = updated.metadata_json["workflow"]["nodes"][0]
    assert node["status"] == "completed"
    assert node["task_statuses"]["app-device-1:identity-task"] == "succeeded"


@pytest.mark.parametrize("task_status", ["running", "succeeded", "failed"])
@pytest.mark.parametrize(
    "orchestration_status,node_status",
    [("waiting_human", "running"), ("completed", "completed"), ("paused", "failed")],
)
def test_task_progress_preserves_ai_assignment_state(
    test_db: Session,
    workflow_project: CloudProject,
    task_status: str,
    orchestration_status: str,
    node_status: str,
) -> None:
    workflow = {
        "version": 1,
        "advancement_policy": "ai",
        "orchestration_status": orchestration_status,
        "assignment": {"id": "assignment-1", "status": orchestration_status},
        "nodes": [
            {
                "id": "review",
                "execution_mode": "robot",
                "status": node_status,
                "task_statuses": {"local-device:old-task": "running"},
            }
        ],
    }
    item = LoopItem(
        id="ai-assignment-progress",
        cloud_project_id=workflow_project.id,
        sequence_number=105,
        created_by_user_id=workflow_project.created_by_user_id,
        title="AI assignment progress",
        description="",
        status="completed" if orchestration_status == "completed" else "in_progress",
        priority="none",
        sort_order=0,
        metadata_json={"workflow": workflow},
    )
    binding = LoopItemTaskBinding(
        cloud_project_id=str(workflow_project.id),
        loop_item_id=item.id,
        task_user_id=workflow_project.created_by_user_id,
        device_id="local-device",
        task_id="current-task",
        linked_by_user_id=workflow_project.created_by_user_id,
        metadata_json={"workflow_node_id": "review"},
    )
    test_db.add_all([item, binding])
    test_db.commit()
    original_status = item.status

    updated = update_workflow_task_status(
        test_db,
        user_id=workflow_project.created_by_user_id,
        device_id="local-device",
        task_id="current-task",
        execution_status=task_status,
    )

    assert updated is not None
    projected = updated.metadata_json["workflow"]
    assert projected["orchestration_status"] == orchestration_status
    assert projected["assignment"] == workflow["assignment"]
    assert projected["nodes"][0]["status"] == node_status
    assert (
        projected["nodes"][0]["task_statuses"]["local-device:current-task"]
        == task_status
    )
    assert updated.status == original_status
