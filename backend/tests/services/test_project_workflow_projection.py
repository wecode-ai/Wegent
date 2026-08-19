# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.user import User
from app.services.project_workflow_projection import update_workflow_node


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


def test_workflow_projection_auto_completes_wait_and_end_nodes(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="workflow-wait-end-item",
        cloud_project_id=workflow_project.id,
        sequence_number=100,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Wait and end",
        description="",
        status="pending",
        priority="none",
        sort_order=0,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [
                    {
                        "id": "start",
                        "name": "Start",
                        "node_type": "start",
                        "depends_on": [],
                        "required": False,
                        "workspace_policy": "none",
                        "status": "completed",
                    },
                    {
                        "id": "develop",
                        "name": "Develop",
                        "node_type": "stage",
                        "depends_on": ["start"],
                        "required": True,
                        "workspace_policy": "composer",
                        "status": "running",
                    },
                    {
                        "id": "wait",
                        "name": "Wait",
                        "node_type": "wait",
                        "depends_on": ["develop"],
                        "required": True,
                        "workspace_policy": "none",
                        "status": "blocked",
                        "wait_config": {
                            "rules": [
                                {
                                    "id": "r",
                                    "event_type": "merged",
                                    "mode": "trigger",
                                    "action": "complete",
                                }
                            ]
                        },
                    },
                    {
                        "id": "end",
                        "name": "End",
                        "node_type": "end",
                        "depends_on": ["wait"],
                        "required": True,
                        "workspace_policy": "none",
                        "status": "blocked",
                    },
                ],
            }
        },
    )
    test_db.add(item)
    test_db.commit()

    update_workflow_node(test_db, item_id=item.id, node_id="develop", node_status="completed")
    test_db.commit()
    assert item.status == "in_progress"
    nodes = {node["id"]: node["status"] for node in item.metadata_json["workflow"]["nodes"]}
    assert nodes["wait"] == "waiting"
    assert nodes["end"] == "blocked"

    update_workflow_node(test_db, item_id=item.id, node_id="wait", node_status="completed")
    test_db.commit()
    nodes = {node["id"]: node["status"] for node in item.metadata_json["workflow"]["nodes"]}
    assert nodes["end"] == "completed"
    assert item.status == "in_review"


def test_workflow_projection_activates_wait_node_while_stage_is_running(
    test_db: Session,
    workflow_project: CloudProject,
) -> None:
    item = LoopItem(
        id="workflow-wait-active-item",
        cloud_project_id=workflow_project.id,
        sequence_number=101,
        created_by_user_id=workflow_project.created_by_user_id,
        title="Wait active during stage",
        description="",
        status="pending",
        priority="none",
        sort_order=0,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [
                    {
                        "id": "start",
                        "name": "Start",
                        "node_type": "start",
                        "depends_on": [],
                        "required": False,
                        "workspace_policy": "none",
                        "status": "completed",
                    },
                    {
                        "id": "develop",
                        "name": "Develop",
                        "node_type": "stage",
                        "depends_on": ["start"],
                        "required": True,
                        "workspace_policy": "composer",
                        "status": "ready",
                    },
                    {
                        "id": "wait",
                        "name": "Wait",
                        "node_type": "wait",
                        "depends_on": ["develop"],
                        "required": True,
                        "workspace_policy": "none",
                        "status": "blocked",
                        "wait_config": {
                            "rules": [
                                {
                                    "id": "r",
                                    "event_type": "merged",
                                    "mode": "trigger",
                                    "action": "complete",
                                }
                            ]
                        },
                    },
                    {
                        "id": "end",
                        "name": "End",
                        "node_type": "end",
                        "depends_on": ["wait"],
                        "required": True,
                        "workspace_policy": "none",
                        "status": "blocked",
                    },
                ],
            }
        },
    )
    test_db.add(item)
    test_db.commit()

    update_workflow_node(test_db, item_id=item.id, node_id="develop", node_status="running")
    test_db.commit()

    nodes = {node["id"]: node["status"] for node in item.metadata_json["workflow"]["nodes"]}
    assert nodes["develop"] == "running"
    assert nodes["wait"] == "waiting"
    assert nodes["end"] == "blocked"
    assert item.status == "in_progress"
