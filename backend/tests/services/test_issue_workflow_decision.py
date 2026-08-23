# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import Delivery, LoopItem, LoopItemTaskBinding
from app.models.user import User
from app.schemas.issue_workflow import WorkflowNodeDecisionRequest
from app.services.issue_workflow_decision import issue_workflow_decision_service


@pytest.fixture
def workflow_item(test_db: Session, test_user: User) -> LoopItem:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="REVIEW",
        name="Review workflow",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        id="workflow-review-item",
        cloud_project_id=project.id,
        sequence_number=1,
        created_by_user_id=test_user.id,
        title="Review",
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
                        "depends_on": [],
                        "required": True,
                        "required_deliverables": [
                            {
                                "id": "test-report",
                                "name": "Test report",
                                "description": "",
                                "value_type": "file",
                                "file_constraints": {
                                    "accepted_types": [],
                                    "min_files": 1,
                                    "max_files": 1,
                                },
                            }
                        ],
                        "delivery_ids": [],
                        "workspace_policy": "composer",
                        "status": "awaiting_approval",
                        "task_ids": ["device:task"],
                        "task_statuses": {"device:task": "succeeded"},
                    },
                    {
                        "id": "test",
                        "name": "Test",
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
    return item


def test_approval_requires_delivery_and_unlocks_successor(
    test_db: Session,
    test_user: User,
    workflow_item: LoopItem,
) -> None:
    with pytest.raises(HTTPException, match="Required workflow deliverables"):
        issue_workflow_decision_service.decide(
            test_db,
            item_id=workflow_item.id,
            workflow_node_id="develop",
            values=WorkflowNodeDecisionRequest(action="approve"),
            user_id=test_user.id,
        )
    test_db.rollback()
    workflow_item = test_db.get(LoopItem, workflow_item.id)
    delivery = Delivery(
        id="delivery-1",
        loop_item_id=workflow_item.id,
        created_by_user_id=test_user.id,
        status="delivered",
        markdown_object_key="deliveries/delivery-1/markdown.md",
        manifest_object_key="deliveries/delivery-1/manifest.json",
        metadata_json={
            "fulfillments": [
                {
                    "requirement_id": "test-report",
                    "kind": "file",
                    "asset_ids": ["asset-1"],
                }
            ]
        },
    )
    test_db.add(delivery)
    workflow_item.metadata_json["workflow"]["nodes"][0]["delivery_ids"] = [delivery.id]
    test_db.commit()

    updated = issue_workflow_decision_service.decide(
        test_db,
        item_id=workflow_item.id,
        workflow_node_id="develop",
        values=WorkflowNodeDecisionRequest(action="approve"),
        user_id=test_user.id,
    )

    nodes = updated.metadata_json["workflow"]["nodes"]
    assert [node["status"] for node in nodes] == ["completed", "ready"]
    assert nodes[0]["decision_history"][0]["action"] == "approve"


def test_force_advance_requires_reason(
    test_db: Session,
    test_user: User,
    workflow_item: LoopItem,
) -> None:
    with pytest.raises(ValueError, match="requires a reason"):
        WorkflowNodeDecisionRequest(action="force_advance")

    updated = issue_workflow_decision_service.decide(
        test_db,
        item_id=workflow_item.id,
        workflow_node_id="develop",
        values=WorkflowNodeDecisionRequest(
            action="force_advance",
            reason="Approved risk exception",
        ),
        user_id=test_user.id,
    )

    assert updated.metadata_json["workflow"]["nodes"][0]["status"] == "forced_completed"


def test_approval_reconciles_stale_failure_from_latest_task(
    test_db: Session,
    test_user: User,
    workflow_item: LoopItem,
) -> None:
    workflow = workflow_item.metadata_json["workflow"]
    workflow["nodes"][0].update(
        {
            "status": "failed",
            "required_deliverables": [],
            "task_ids": ["device:task-1", "device:task-2"],
            "task_statuses": {
                "device:task-1": "failed",
                "device:task-2": "succeeded",
            },
        }
    )
    test_db.add_all(
        [
            LoopItemTaskBinding(
                cloud_project_id=str(workflow_item.cloud_project_id),
                loop_item_id=workflow_item.id,
                task_user_id=test_user.id,
                device_id="device",
                task_id="task-1",
                linked_by_user_id=test_user.id,
                linked_at=datetime(2026, 8, 18, 10, tzinfo=timezone.utc),
                metadata_json={"workflow_node_id": "develop"},
            ),
            LoopItemTaskBinding(
                cloud_project_id=str(workflow_item.cloud_project_id),
                loop_item_id=workflow_item.id,
                task_user_id=test_user.id,
                device_id="device",
                task_id="task-2",
                linked_by_user_id=test_user.id,
                linked_at=datetime(2026, 8, 18, 11, tzinfo=timezone.utc),
                metadata_json={"workflow_node_id": "develop"},
            ),
        ]
    )
    test_db.commit()

    updated = issue_workflow_decision_service.decide(
        test_db,
        item_id=workflow_item.id,
        workflow_node_id="develop",
        values=WorkflowNodeDecisionRequest(action="approve"),
        user_id=test_user.id,
    )

    assert updated.metadata_json["workflow"]["nodes"][0]["status"] == "completed"
