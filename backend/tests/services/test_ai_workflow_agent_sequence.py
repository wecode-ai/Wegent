# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contract for one AI-managed Issue advancing through fixed agent stages."""

import uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowNodeDefinition,
    instantiate_workflow,
)
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automations import project_automation_service


class _SessionContext:
    def __init__(self, db: Session) -> None:
        self._db = db

    def __enter__(self) -> Session:
        return self._db

    def __exit__(self, exc_type: object, *_args: object) -> None:
        if exc_type is not None:
            self._db.rollback()


def _token(user: User) -> MCPAuthInfo:
    return MCPAuthInfo(
        user_id=user.id,
        user_name=user.user_name,
        auth_type="task",
        task_id=1,
        subtask_id=1,
    )


def _agent(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    name: str,
    runtime: str,
) -> ProjectChatAgent:
    device_key = f"{runtime}-{uuid.uuid4().hex[:10]}"
    db.add(
        Kind(
            kind="Device",
            name=device_key,
            namespace="default",
            user_id=user.id,
            is_active=True,
            json={"spec": {"deviceType": "local"}},
        )
    )
    agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title=name,
        name=name,
        status="active",
        created_by_user_id=user.id,
        device_id=device_key,
        metadata_json={
            "runtime": runtime,
            "model": f"{runtime}-test-model",
            "execution_mode": "auto",
            "execution_environment": "local",
            "visibility": "public",
        },
    )
    db.add(agent)
    db.flush()
    return agent


def _plan(agent: ProjectChatAgent, *, key: str) -> dict[str, object]:
    return {
        "summary": f"Run {key}.",
        "items": [
            {
                "client_key": key,
                "title": key,
                "description": f"Complete {key} and report the outcome.",
                "assignee_type": "agent",
                "assignee_id": agent.id,
                "assignee_name": agent.name,
                "rationale": f"{agent.name} is required by this stage.",
            }
        ],
    }


@pytest.mark.asyncio
async def test_ai_workflow_enforces_claude_then_codex_until_issue_completed(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key=f"SEQ{uuid.uuid4().hex[:6].upper()}",
        name="Sequential agent workflow",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{uuid.uuid4()}",
        metadata_json={},
    )
    test_db.add(project)
    test_db.flush()
    claude = _agent(
        test_db,
        project,
        test_user,
        name="Claude agent",
        runtime="claude_code",
    )
    codex = _agent(
        test_db,
        project,
        test_user,
        name="Codex agent",
        runtime="codex",
    )
    definition = ProjectWorkflowDefinition(
        version=1,
        stage_mode="dag",
        advancement_policy="ai",
        approval_policy="automatic",
        ai_automation_rule_id="allocator-rule",
        nodes=[
            WorkflowNodeDefinition(
                id="claude",
                name="Claude implementation",
                execution_mode="robot",
                required_assignee_type="agent",
                required_assignee_id=claude.id,
            ),
            WorkflowNodeDefinition(
                id="codex",
                name="Codex verification",
                execution_mode="robot",
                depends_on=["claude"],
                required_assignee_type="agent",
                required_assignee_id=codex.id,
            ),
        ],
    )
    allocator_rule = ProjectAutomationRule(
        id="allocator-rule",
        cloud_project_id=project.id,
        title="Sequential allocator",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "custom"},
    )
    root_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=allocator_rule.id,
        task_id="sequence-issue",
        title="Sequential agent workflow",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([allocator_rule, root_run])
    test_db.flush()
    issue = LoopItem(
        id="sequence-issue",
        cloud_project_id=project.id,
        title="Implement and verify",
        description="Claude implements, then Codex verifies.",
        status="in_progress",
        priority="medium",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow_automation": {
                "rule_id": "allocator-rule",
                "run_id": root_run.id,
            },
            "workflow": instantiate_workflow(definition).model_dump(mode="json"),
        },
    )
    test_db.add(issue)
    test_db.commit()
    manager_runs: dict[str, ProjectAutomationRun] = {}

    async def dispatch_manager_run(
        db: Session,
        *,
        workflow_run_id: str,
        **_kwargs: object,
    ) -> dict[str, object]:
        run = ProjectAutomationRun(
            cloud_project_id=project.id,
            parent_id=allocator_rule.id,
            task_id=issue.id,
            title="Manager planning run",
            status="running",
            created_by_user_id=test_user.id,
            metadata_json={},
        )
        db.add(run)
        db.flush()
        message_id = str(uuid.uuid4())
        activity = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(project.id),
            task_id=issue.id,
            sender_type="agent",
            sender_id=f"automation_manager:{allocator_rule.id}",
            sender_name="AI manager",
            message_type="agent_status",
            content="",
            metadata_json={
                "automation_run_id": str(run.id),
                "run_status": "running",
            },
            status="streaming",
        )
        run.metadata_json = {
            "activity_message_id": message_id,
            "event": {
                "type": (
                    "workflow.review"
                    if _kwargs.get("phase") == "review"
                    else "workflow.plan"
                ),
                "payload": {"workflow_run_id": workflow_run_id},
            },
        }
        db.add(activity)
        db.commit()
        manager_runs[workflow_run_id] = run
        return {"id": run.id}

    dispatch_manager = AsyncMock(side_effect=dispatch_manager_run)
    monkeypatch.setattr(
        project_automation_service,
        "run_ai_workflow_manager",
        dispatch_manager,
    )
    monkeypatch.setattr(
        wework_space,
        "SessionLocal",
        lambda: _SessionContext(test_db),
    )
    scheduled_execution_ids: list[int] = []
    monkeypatch.setattr(
        "app.services.board_team_execution.schedule_board_robot_execution_by_id",
        scheduled_execution_ids.append,
    )
    consume_queues = AsyncMock()
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        consume_queues,
    )
    mcp_context: dict[str, object] = {}
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_args, **_kwargs: dict(mcp_context),
    )
    token = _token(test_user)

    assert (
        await issue_workflow_start_service.start(
            test_db,
            item=issue,
            project=project,
            user_id=test_user.id,
        )
        == 1
    )
    first_run = issue_workflow_planning_service.get(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    assert first_run is not None
    assert first_run.stage_id == "claude"
    mcp_context.update(
        {
            "source": "project_automation",
            "space_id": str(project.id),
            "item_id": issue.id,
            "project_automation_run_id": str(manager_runs[first_run.run_id].id),
        }
    )

    with pytest.raises(
        ValueError,
        match="Workflow plan assignee does not match the stage constraint",
    ):
        await wework_space.submit_workflow_plan(
            token,
            _plan(codex, key="wrong-stage-one-assignee"),
            space_id=str(project.id),
            item_id=issue.id,
        )

    first_submitted = await wework_space.submit_workflow_plan(
        token,
        _plan(claude, key="implement"),
        space_id=str(project.id),
        item_id=issue.id,
    )
    assert first_submitted["status"] == "running"
    assert consume_queues.await_count == 1
    claude_task_id = first_submitted["items"][0]["task_id"]
    assert claude_task_id is not None
    claude_task = test_db.get(LoopItem, claude_task_id)
    assert claude_task is not None
    assert claude_task.assignee_agent_id == claude.id
    assert claude_task.status == "pending"
    claude_execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == claude_task_id)
        .one()
    )
    assert claude_execution.agent_id == claude.id
    completed_claude_execution = loop_item_execution_service.complete(
        test_db,
        execution_id=claude_execution.id,
        note="Claude execution completed.",
    )
    assert completed_claude_execution is not None
    assert completed_claude_execution.status == "completed"

    mcp_context.update(
        {
            "source": "board_team_assignment",
            "item_id": claude_task_id,
            "board_team_execution_id": str(claude_execution.id),
        }
    )
    first_reported = await wework_space.report_workflow_outcome(
        token,
        "passed",
        "Claude implementation completed.",
        space_id=str(project.id),
        item_id=claude_task_id,
    )
    assert first_reported["status"] == "awaiting_review"
    assert first_reported["stage_id"] == "claude"
    assert test_db.get(LoopItem, claude_task_id).status == "in_review"
    assert test_db.get(LoopItem, issue.id).status == "in_progress"
    mcp_context.update(
        {
            "source": "project_automation",
            "item_id": issue.id,
            "project_automation_run_id": str(manager_runs[first_run.run_id].id),
        }
    )
    first_decided = await wework_space.decide_workflow_review(
        token,
        "completed",
        "Claude implementation is ready for Codex verification.",
        space_id=str(project.id),
        item_id=issue.id,
    )
    assert first_decided["status"] == "planning"
    assert first_decided["stage_id"] == "codex"
    assert test_db.get(LoopItem, claude_task_id).status == "completed"
    second_run_id = str(first_decided["run_id"])
    mcp_context.update(
        {
            "source": "project_automation",
            "item_id": issue.id,
            "project_automation_run_id": str(manager_runs[second_run_id].id),
        }
    )
    with pytest.raises(
        ValueError,
        match="Workflow plan assignee does not match the stage constraint",
    ):
        await wework_space.submit_workflow_plan(
            token,
            _plan(claude, key="wrong-stage-two-assignee"),
            space_id=str(project.id),
            item_id=issue.id,
        )

    second_submitted = await wework_space.submit_workflow_plan(
        token,
        _plan(codex, key="verify"),
        space_id=str(project.id),
        item_id=issue.id,
    )
    assert second_submitted["status"] == "running"
    assert consume_queues.await_count == 2
    codex_task_id = second_submitted["items"][0]["task_id"]
    assert codex_task_id is not None
    codex_task = test_db.get(LoopItem, codex_task_id)
    assert codex_task is not None
    assert codex_task.assignee_agent_id == codex.id
    codex_execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == codex_task_id)
        .one()
    )
    assert codex_execution.agent_id == codex.id
    completed_codex_execution = loop_item_execution_service.complete(
        test_db,
        execution_id=codex_execution.id,
        note="Codex execution completed.",
    )
    assert completed_codex_execution is not None
    assert completed_codex_execution.status == "completed"

    mcp_context.update(
        {
            "source": "board_team_assignment",
            "item_id": codex_task_id,
            "board_team_execution_id": str(codex_execution.id),
        }
    )
    second_reported = await wework_space.report_workflow_outcome(
        token,
        "passed",
        "Codex verification completed.",
        space_id=str(project.id),
        item_id=codex_task_id,
    )
    assert second_reported["status"] == "awaiting_review"
    assert test_db.get(LoopItem, codex_task_id).status == "in_review"
    assert test_db.get(LoopItem, issue.id).status == "in_progress"
    mcp_context.update(
        {
            "source": "project_automation",
            "item_id": issue.id,
            "project_automation_run_id": str(manager_runs[second_run_id].id),
        }
    )
    completed = await wework_space.decide_workflow_review(
        token,
        "completed",
        "Codex verification passed; the Issue is complete.",
        space_id=str(project.id),
        item_id=issue.id,
    )

    test_db.refresh(root_run)
    test_db.refresh(issue)
    assert completed["status"] == "completed"
    assert test_db.get(LoopItem, codex_task_id).status == "completed"
    assert root_run.status == "succeeded"
    assert root_run.completed_at is not None
    assert issue.metadata_json["workflow"]["orchestration_status"] == "completed"
    assert [node["status"] for node in issue.metadata_json["workflow"]["nodes"]] == [
        "completed",
        "completed",
    ]
    assert issue.status == "completed"
    assert issue.completed_at is not None
    assert [entry["to_status"] for entry in issue.metadata_json["status_history"]] == [
        "completed",
    ]

    assert dispatch_manager.await_count == 4
    assert [
        call.kwargs["automation_id"] for call in dispatch_manager.await_args_list
    ] == [
        "allocator-rule",
        "allocator-rule",
        "allocator-rule",
        "allocator-rule",
    ]
    assert [
        call.kwargs["workflow_run_id"] for call in dispatch_manager.await_args_list
    ] == [first_run.run_id, first_run.run_id, second_run_id, second_run_id]
    assert first_run.run_id != second_run_id
    assert len(manager_runs) == 2
    assert {manager_run.parent_id for manager_run in manager_runs.values()} == {
        allocator_rule.id
    }
    assert scheduled_execution_ids == [claude_execution.id, codex_execution.id]
