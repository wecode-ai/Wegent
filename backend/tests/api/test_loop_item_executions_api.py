# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused API tests for LoopItem execution ownership."""

from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.endpoints import loop_item_executions
from app.models.delivery import (
    CloudProject,
    Delivery,
    LoopItem,
    LoopItemTaskBinding,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.project_chat import (
    LoopItemExecutionAssignmentStatus,
    LoopItemExecutionBatchCreate,
    LoopItemExecutionBatchItem,
    LoopItemExecutionStatusQuery,
)


def test_runtime_write_back_authorizes_execution_owner(
    test_db: Session,
    test_user: User,
) -> None:
    agent_creator = User(
        user_name="agent-creator",
        password_hash="unused",
        email="agent-creator@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(agent_creator)
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id="issue-write-back",
        cloud_project_id="73",
        executor_owner_user_id=test_user.id,
        agent_id="shared-agent",
        status="claimed",
    )
    test_db.add(execution)
    test_db.commit()
    test_db.refresh(execution)

    authorized = loop_item_executions._require_run_owner(
        test_db,
        project_id=73,
        execution_id=execution.id,
        user_id=test_user.id,
    )

    assert authorized.id == execution.id
    with pytest.raises(HTTPException) as error:
        loop_item_executions._require_run_owner(
            test_db,
            project_id=73,
            execution_id=execution.id,
            user_id=agent_creator.id,
        )
    assert error.value.status_code == 403


def test_collaboration_batch_records_activity_and_persists_human_fact(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
) -> None:
    push = Mock()
    monkeypatch.setattr(loop_item_executions, "push_project_chat_message", push)
    public_id = str(uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"MIXED{uuid4().hex[:4].upper()}",
        name="Mixed collaboration batch",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
        next_item_number=2,
    )
    test_db.add(project)
    test_db.flush()
    manager = ProjectChatAgent(
        id=f"manager-{uuid4().hex}",
        cloud_project_id=project.id,
        title="Manager",
        name="Manager",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"wegent_team_id": 1001},
    )
    worker = ProjectChatAgent(
        id=f"worker-{uuid4().hex}",
        cloud_project_id=project.id,
        title="Worker",
        name="Worker",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"wegent_team_id": 1002},
    )
    parent = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Parent Issue",
        description="",
        status="in_progress",
        priority="none",
        created_by_user_id=test_user.id,
        metadata_json={"collaboration_group": {"id": "group-1", "name": "Mixed team"}},
    )
    manager_execution = LoopItemExecution(
        loop_item_id=parent.id,
        cloud_project_id=str(project.id),
        agent_id="",
        executor_owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        runtime_device_id="manager-device",
        runtime_instance_id="manager-instance",
        runtime_task_id="manager-runtime-1",
        execution_environment="cloud",
        execution_payload=(
            '{"runtime_selection":{"executor_kind":'
            '"collaboration_group_dispatch"},'
            '"origin_context":{"dispatch_role":"manager",'
            f'"manager_agent_id":"{manager.id}",'
            '"dispatch_id":"dispatch-1"}}'
        ),
        status="running",
    )
    test_db.add_all([manager, worker, parent, manager_execution])
    test_db.commit()

    group = {
        "id": "group-1",
        "leader": {"kind": "agent", "id": "1001"},
        "members": [
            {"kind": "agent", "id": "1001"},
            {"kind": "agent", "id": "1002"},
            {"kind": "human", "id": str(test_user.id)},
        ],
    }
    monkeypatch.setattr(
        loop_item_executions,
        "collaboration_group_for_item",
        lambda *_args, **_kwargs: group,
    )

    values = LoopItemExecutionBatchCreate(
        loop_item_id=parent.id,
        dispatch_id="dispatch-1",
        round_id="round-1",
        manager_runtime_task_id="manager-runtime-1",
        manager_agent_id=manager.id,
        items=[
            LoopItemExecutionBatchItem(
                assignment_id="agent-assignment",
                title="Agent task",
                instructions="Collect evidence.",
                assignee_type="agent",
                assignee_id=worker.id,
            ),
            LoopItemExecutionBatchItem(
                assignment_id="human-assignment",
                title="Human task",
                instructions="Provide business approval.",
                assignee_type="human",
                assignee_id=str(test_user.id),
                workflow_stage_id="approval",
            ),
        ],
    )

    first = loop_item_executions.enqueue_execution_batch(
        project.id, values, test_db, test_user
    )
    second = loop_item_executions.enqueue_execution_batch(
        project.id, values, test_db, test_user
    )

    assert "assignments" not in first
    assert len(first["human_assignments"]) == 1
    assert first["human_assignments"][0]["assignee_type"] == "human"
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.agent_id == worker.id)
        .count()
        == 0
    )
    human_assignment_id = first["human_assignments"][0]["human_assignment_id"]
    assert second["human_assignments"][0]["human_assignment_id"] == human_assignment_id
    assert test_db.query(LoopItem).filter(LoopItem.parent_id == parent.id).count() == 0
    notifications = (
        test_db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == test_user.id,
            WeworkNotification.kind == "issue_dispatch_assignment",
        )
        .all()
    )
    assert len(notifications) == 1
    assert notifications[0].payload["humanAssignmentId"] == human_assignment_id
    assert notifications[0].payload["itemId"] == parent.id
    activities = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.task_id == parent.id,
            ProjectChatMessage.sender_id == manager.id,
        )
        .all()
    )
    assert len(activities) == 1
    assignments = activities[0].metadata_json["dispatch_assignments"]
    assert assignments[0]["agent_name"] == "Worker"
    assert assignments[1]["human_user_name"] == test_user.user_name
    push.assert_called_once()
    assert push.call_args.args[0]["metadata"]["dispatch_assignments"] == assignments
    test_db.refresh(manager_execution)
    assert manager_execution.status == "running"

    push.reset_mock()
    running = loop_item_executions.report_collaboration_assignment_status(
        project.id,
        LoopItemExecutionAssignmentStatus(
            loop_item_id=parent.id,
            dispatch_id="dispatch-1",
            round_id="round-1",
            assignment_id="agent-assignment",
            runtime_device_id="executor-device",
            runtime_task_id="member-runtime-task",
            status="running",
        ),
        test_db,
        test_user,
    )
    assert running["changed"] is True
    assert running["message"]["sender"]["name"] == "Worker"
    assert running["message"]["metadata"]["workflow_task_title"] == "Agent task"
    assert running["message"]["metadata"]["dispatch_role"] == "member"
    assert running["message"]["runtimeAddress"] == {
        "deviceId": "executor-device",
        "taskId": "member-runtime-task",
    }
    push.assert_called_once()

    push.reset_mock()
    completed = loop_item_executions.report_collaboration_assignment_status(
        project.id,
        LoopItemExecutionAssignmentStatus(
            loop_item_id=parent.id,
            dispatch_id="dispatch-1",
            round_id="round-1",
            assignment_id="agent-assignment",
            runtime_device_id="executor-device",
            runtime_task_id="member-runtime-task",
            status="completed",
            result="Agent evidence delivered.",
        ),
        test_db,
        test_user,
    )
    assert completed["changed"] is True
    assert completed["message"]["content"] == "Agent evidence delivered."
    assert completed["message"]["metadata"]["run_status"] == "completed"
    push.assert_called_once()

    push.reset_mock()
    duplicate = loop_item_executions.report_collaboration_assignment_status(
        project.id,
        LoopItemExecutionAssignmentStatus(
            loop_item_id=parent.id,
            dispatch_id="dispatch-1",
            round_id="round-1",
            assignment_id="agent-assignment",
            runtime_device_id="executor-device",
            runtime_task_id="member-runtime-task",
            status="completed",
            result="Agent evidence delivered.",
        ),
        test_db,
        test_user,
    )
    assert duplicate["changed"] is False
    push.assert_not_called()

    binding = LoopItemTaskBinding(
        cloud_project_id=str(project.id),
        loop_item_id=parent.id,
        task_user_id=test_user.id,
        device_id="human-device",
        task_id="human-runtime-task",
        task_title="Human task",
        linked_by_user_id=test_user.id,
        metadata_json={"human_assignment_id": human_assignment_id},
    )
    test_db.add(binding)
    test_db.flush()
    delivery = Delivery(
        id=str(uuid4()),
        loop_item_id=parent.id,
        created_by_user_id=test_user.id,
        source_task_binding_id=str(binding.id),
        source_task_snapshot={},
        status="delivered",
        markdown_object_key="human-delivery.md",
    )
    test_db.add(delivery)
    test_db.commit()
    monkeypatch.setattr(
        loop_item_executions.collaboration_human_assignment_status.__globals__[
            "delivery_service"
        ],
        "read_markdown",
        lambda _delivery: "Business evidence delivered.",
    )
    status_result = loop_item_executions.execution_statuses(
        project.id,
        LoopItemExecutionStatusQuery(
            loop_item_id=parent.id,
            human_assignment_ids=[human_assignment_id],
        ),
        test_db,
        test_user,
    )

    assert status_result["items"][0]["assignee_type"] == "human"
    assert status_result["items"][0]["work_id"] == (
        f"human_assignment:{human_assignment_id}"
    )
    assert status_result["items"][0]["status"] == "completed"
    assert status_result["items"][0]["human_user_id"] == test_user.id
    assert status_result["items"][0]["delivery_id"] == delivery.id
    assert status_result["items"][0]["result"] == "Business evidence delivered."
