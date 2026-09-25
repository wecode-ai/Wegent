# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused API tests for LoopItem execution ownership."""

from contextlib import contextmanager
from types import SimpleNamespace
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
    LoopItemExecutionBatchCreate,
    LoopItemExecutionBatchItem,
    LoopItemExecutionClaim,
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


def test_agent_claim_uses_run_owner_not_agent_creator(
    monkeypatch,
    test_db: Session,
    test_user: User,
) -> None:
    run_owner = User(
        user_name="execution-owner",
        password_hash="unused",
        email="execution-owner@example.com",
        is_active=True,
        git_info=None,
    )
    project = CloudProject(
        public_id="execution-owner-project",
        project_key="RUNOWNER",
        name="Run owner project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix="projects/execution-owner-project",
        metadata_json={},
    )
    test_db.add_all([run_owner, project])
    test_db.flush()
    agent = ProjectChatAgent(
        id="agent-created-by-project-owner",
        cloud_project_id=project.id,
        title="Shared agent",
        name="Shared agent",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(agent)
    test_db.commit()
    test_db.refresh(run_owner)
    test_db.refresh(project)

    claimed = LoopItemExecution(
        id=41,
        loop_item_id="issue-1",
        cloud_project_id=str(project.id),
        executor_owner_user_id=run_owner.id,
        agent_id=agent.id,
        execution_environment="local",
        execution_device_id="owner-device",
        status="claimed",
    )
    claim = Mock(return_value=claimed)
    monkeypatch.setattr(
        loop_item_executions.loop_item_execution_service,
        "claim",
        claim,
    )
    monkeypatch.setattr(
        loop_item_executions,
        "get_runtime_capacity_sync",
        lambda *_args, **_kwargs: SimpleNamespace(
            runtime_instance_id="runtime-owner",
            limit=1,
            active=0,
            active_task_ids=set(),
        ),
    )

    @contextmanager
    def acquired(*_args, **_kwargs):
        yield True

    monkeypatch.setattr(
        loop_item_executions.distributed_lock,
        "acquire_context",
        acquired,
    )
    monkeypatch.setattr(
        loop_item_executions,
        "_claimed_execution_view",
        lambda _db, row: row,
    )

    result = loop_item_executions.claim_execution(
        project_id=project.id,
        values=LoopItemExecutionClaim(
            agent_id=agent.id,
            execution_device_id="owner-device",
            execution_environment="local",
        ),
        db=test_db,
        current_user=run_owner,
    )

    assert result is claimed
    claim.assert_called_once_with(
        test_db,
        agent_id=agent.id,
        execution_device_id="owner-device",
        environment="local",
        owner_user_id=run_owner.id,
        runtime_instance_id="runtime-owner",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        lease_seconds=300,
        assigner_filter=None,
    )


def test_collaboration_batch_persists_agent_and_human_assignment_facts(
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
    test_db.add_all([manager, worker, parent])
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

    def create_agent_execution(db: Session, **kwargs: object) -> LoopItemExecution:
        context = dict(kwargs["automation_context"])
        row = LoopItemExecution(
            loop_item_id=parent.id,
            cloud_project_id=str(project.id),
            agent_id=worker.id,
            executor_owner_user_id=test_user.id,
            assigner_user_id=test_user.id,
            automation_run_id=str(context["run_id"]),
            runtime_task_id="runtime-agent-1",
            execution_environment="local",
            status="queued",
        )
        db.add(row)
        db.flush()
        return row

    monkeypatch.setattr(
        loop_item_executions.loop_item_execution_service,
        "create_for_assignment",
        create_agent_execution,
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

    assert [entry["assignee_type"] for entry in first["executions"]] == [
        "agent",
        "human",
    ]
    human_assignment_id = first["executions"][1]["human_assignment_id"]
    assert second["executions"][1]["human_assignment_id"] == human_assignment_id
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
            execution_ids=[first["executions"][0]["execution_id"]],
            human_assignment_ids=[human_assignment_id],
        ),
        test_db,
        test_user,
    )

    assert status_result["items"][0]["assignee_type"] == "agent"
    assert status_result["items"][1]["assignee_type"] == "human"
    assert status_result["items"][1]["work_id"] == (
        f"human_assignment:{human_assignment_id}"
    )
    assert status_result["items"][1]["status"] == "completed"
    assert status_result["items"][1]["human_user_id"] == test_user.id
    assert status_result["items"][1]["delivery_id"] == delivery.id
    assert status_result["items"][1]["result"] == "Business evidence delivered."
