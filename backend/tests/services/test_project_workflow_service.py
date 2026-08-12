# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for project AI-development workflows."""

import uuid
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_workflow import (
    ProjectWorkflowAutomation,
    ProjectWorkflowAutomationRun,
    TaskDevelopmentLink,
    TaskStageRun,
    TaskWorkflowRun,
    TaskWorkspace,
)
from app.models.user import User
from app.schemas.project_workflow import (
    ExecutionActorRef,
    ExecutionTargetRef,
    ProjectAgentSquadCreate,
    ProjectWorkflowAutomationCreate,
    ProjectWorkflowAutomationRunRequest,
    PullRequestCreate,
    PullRequestMerge,
    RepositoryBindingCreate,
    RepositoryProviderEventInput,
    TaskExecutionBindingUpsert,
    WorkflowAction,
    WorkflowArtifactCreate,
    WorkflowDefinitionCreate,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_workflows.provider import PullRequestState
from app.services.project_workflows.service import project_workflow_service
from app.services.project_workflows.state import (
    can_transition_stage,
    can_transition_workflow,
)


def _create_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"WF{uuid.uuid4().hex[:8].upper()}",
        name="Workflow project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _create_agent(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    agent_id: str,
) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=agent_id,
        cloud_project_id=str(project.id),
        title=f"Agent {agent_id}",
        name=f"Agent {agent_id}",
        status="active",
        created_by_user_id=user.id,
        metadata_json={"runtime": "codex"},
    )
    db.add(agent)
    db.commit()
    return agent


def _create_task(db: Session, project: CloudProject, user: User) -> LoopItem:
    task = LoopItem(
        id=uuid.uuid4().hex,
        cloud_project_id=str(project.id),
        parent_id=str(project.id),
        title="Implement workflow",
        description="Build the feature",
        status="backlog",
        priority="high",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(task)
    db.commit()
    return task


def test_execution_actor_and_target_contracts_are_orthogonal() -> None:
    team = ExecutionActorRef(
        type="wegent_team",
        team_id=42,
        namespace="default",
        name="Developer",
        user_id=7,
    )
    container = ExecutionTargetRef(type="managed_container")

    assert team.stable_id() == "42"
    assert container.id is None
    with pytest.raises(ValueError):
        ExecutionTargetRef(type="registered_device")


def _create_automatic_workflow(
    db: Session,
    project: CloudProject,
    user: User,
) -> str:
    workflow = project_workflow_service.create_workflow(
        db,
        project_id=project.id,
        user_id=user.id,
        request=WorkflowDefinitionCreate(
            name="Automated delivery",
            trigger_mode="automatic",
            stages=[
                {
                    "key": "finish",
                    "name": "Finish",
                    "nodes": [
                        {
                            "key": "complete",
                            "name": "Complete",
                            "type": "complete",
                        }
                    ],
                }
            ],
        ),
    )
    return workflow.id


def test_project_workflow_automation_creates_task_and_starts_workflow_once(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    workflow_id = _create_automatic_workflow(test_db, project, test_user)
    automation = project_workflow_service.create_automation(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=ProjectWorkflowAutomationCreate(
            name="Nightly maintenance",
            description="Create and execute the maintenance task",
            trigger_type="manual",
            workflow_id=workflow_id,
            execution_target=ExecutionTargetRef(type="managed_container"),
            task_template={
                "title": "Automated maintenance",
                "priority": "high",
            },
        ),
    )

    first = project_workflow_service.run_automation(
        test_db,
        project_id=project.id,
        automation_id=automation.id,
        user_id=test_user.id,
        request=ProjectWorkflowAutomationRunRequest(
            idempotency_key="manual-once",
        ),
    )
    repeated = project_workflow_service.run_automation(
        test_db,
        project_id=project.id,
        automation_id=automation.id,
        user_id=test_user.id,
        request=ProjectWorkflowAutomationRunRequest(
            idempotency_key="manual-once",
        ),
    )

    task = test_db.get(LoopItem, first.loop_item_id)
    workflow_run = test_db.get(TaskWorkflowRun, first.workflow_run_id)
    assert repeated.id == first.id
    assert first.status == "succeeded"
    assert task is not None
    assert task.title == "Automated maintenance"
    assert task.priority == "high"
    assert task.status == "completed"
    assert workflow_run is not None
    assert workflow_run.status == "completed"
    assert (
        test_db.query(ProjectWorkflowAutomationRun)
        .filter(ProjectWorkflowAutomationRun.automation_id == automation.id)
        .count()
        == 1
    )


def test_due_project_workflow_automation_advances_interval_schedule(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    workflow_id = _create_automatic_workflow(test_db, project, test_user)
    view = project_workflow_service.create_automation(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=ProjectWorkflowAutomationCreate(
            name="Hourly maintenance",
            trigger_type="interval",
            trigger_config={"value": 1, "unit": "hours"},
            workflow_id=workflow_id,
            execution_target=ExecutionTargetRef(type="managed_container"),
            task_template={"title": "Hourly task"},
        ),
    )
    automation = test_db.get(ProjectWorkflowAutomation, view.id)
    assert automation is not None
    automation.next_run_at = datetime(2000, 1, 1)
    test_db.commit()

    completed = project_workflow_service.run_due_automations(test_db)

    test_db.refresh(automation)
    assert completed == 1
    assert automation.next_run_at > automation.last_run_at
    assert (
        test_db.query(ProjectWorkflowAutomationRun)
        .filter(ProjectWorkflowAutomationRun.automation_id == automation.id)
        .count()
        == 1
    )


def test_workflow_and_stage_transitions_reject_terminal_shortcuts() -> None:
    assert can_transition_workflow("queued", "running")
    assert can_transition_stage("running", "passed")
    assert not can_transition_workflow("completed", "running")
    assert not can_transition_stage("passed", "failed")


def test_project_agent_squad_binding_and_single_actor_run(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    first = _create_agent(test_db, project, test_user, agent_id="agent-1")
    second = _create_agent(test_db, project, test_user, agent_id="agent-2")
    task = _create_task(test_db, project, test_user)

    squad = project_workflow_service.create_squad(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=ProjectAgentSquadCreate(
            name="Delivery squad",
            leader_agent_id=first.id,
            member_agent_ids=[first.id, second.id],
            max_parallel_members=2,
        ),
    )
    binding = project_workflow_service.upsert_task_binding(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        request=TaskExecutionBindingUpsert(
            actor=ExecutionActorRef(type="project_squad", id=squad.id),
            execution_target=ExecutionTargetRef(type="managed_container"),
            workspace_mode="git_worktree",
        ),
    )
    run = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="start-once",
    )
    repeated = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="start-once",
    )

    stages = (
        test_db.query(TaskStageRun)
        .filter(TaskStageRun.workflow_run_id == run.id)
        .order_by(TaskStageRun.node_key)
        .all()
    )
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.workflow_run_id == run.id)
        .all()
    )
    assert binding.target_type == "project_squad"
    assert binding.execution_target.type == "managed_container"
    assert run.id == repeated.id
    assert run.status == "queued"
    assert {stage.target_id for stage in stages} == {first.id, second.id}
    assert {stage.target_type for stage in stages} == {"project_agent"}
    assert {stage.status for stage in stages} == {"queued"}
    assert len(executions) == 2
    assert {execution.stage_run_id for execution in executions} == {
        stage.id for stage in stages
    }
    assert {execution.execution_target_type for execution in executions} == {
        "managed_container"
    }


def test_workflow_definition_resolves_project_agent(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    agent = _create_agent(test_db, project, test_user, agent_id="agent-workflow")

    workflow = project_workflow_service.create_workflow(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=WorkflowDefinitionCreate.model_validate(
            {
                "name": "Development",
                "stages": [
                    {
                        "key": "develop",
                        "name": "Develop",
                        "nodes": [
                            {
                                "key": "implement",
                                "name": "Implement",
                                "type": "agent",
                                "actor": {
                                    "type": "project_agent",
                                    "id": agent.id,
                                },
                                "requiredOutputs": ["implementation_report"],
                            }
                        ],
                    }
                ],
            }
        ),
    )

    assert workflow.stages[0].nodes[0].actor
    assert workflow.stages[0].nodes[0].actor.id == agent.id


def test_registered_device_must_belong_to_current_user(
    test_db: Session,
    test_user: User,
) -> None:
    other = User(
        user_name=f"other-{uuid.uuid4().hex[:8]}",
        password_hash="unused",
        email=f"{uuid.uuid4().hex[:8]}@example.com",
        is_active=True,
    )
    test_db.add(other)
    test_db.flush()
    test_db.add(
        Kind(
            kind="Device",
            name="other-device",
            namespace="default",
            user_id=other.id,
            is_active=True,
            json={"spec": {"deviceType": "local"}},
        )
    )
    test_db.commit()

    with pytest.raises(HTTPException) as exc:
        project_workflow_service.resolve_execution_target(
            test_db,
            user_id=test_user.id,
            target=ExecutionTargetRef(
                type="registered_device",
                id="other-device",
            ),
        )

    assert exc.value.status_code == 404


def test_wegent_team_reference_requires_exact_owner_namespace_and_name(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _create_project(test_db, test_user)
    team = Kind(
        kind="Team",
        name="Developer",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "Developer", "namespace": "default"},
            "spec": {"members": []},
        },
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    monkeypatch.setattr(
        "app.services.project_workflows.service.team_kinds_service.get_team_detail",
        lambda **_: {},
    )

    snapshot = project_workflow_service.resolve_actor(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        actor=ExecutionActorRef(
            type="wegent_team",
            team_id=team.id,
            namespace="default",
            name="Developer",
            user_id=test_user.id,
        ),
    )
    assert snapshot["teamId"] == team.id

    with pytest.raises(HTTPException) as exc:
        project_workflow_service.resolve_actor(
            test_db,
            project_id=project.id,
            user_id=test_user.id,
            actor=ExecutionActorRef(
                type="wegent_team",
                team_id=team.id,
                namespace="default",
                name="Different",
                user_id=test_user.id,
            ),
        )
    assert exc.value.status_code == 409


def test_started_run_persists_real_user_and_separate_idempotency_key(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    agent = _create_agent(test_db, project, test_user, agent_id="agent-idempotency")
    task = _create_task(test_db, project, test_user)
    project_workflow_service.upsert_task_binding(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        request=TaskExecutionBindingUpsert(
            actor=ExecutionActorRef(type="project_agent", id=agent.id),
            execution_target=ExecutionTargetRef(type="managed_container"),
        ),
    )

    view = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="request-123",
    )
    row = test_db.get(TaskWorkflowRun, view.id)

    assert row
    assert row.started_by_id == str(test_user.id)
    assert row.idempotency_key == "request-123"


def test_squad_runs_every_member_with_bounded_parallelism(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    agents = [
        _create_agent(
            test_db,
            project,
            test_user,
            agent_id=f"bounded-agent-{index}",
        )
        for index in range(3)
    ]
    task = _create_task(test_db, project, test_user)
    squad = project_workflow_service.create_squad(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=ProjectAgentSquadCreate(
            name="Bounded squad",
            leader_agent_id=agents[0].id,
            member_agent_ids=[agent.id for agent in agents],
            max_parallel_members=1,
        ),
    )
    project_workflow_service.upsert_task_binding(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        request=TaskExecutionBindingUpsert(
            actor=ExecutionActorRef(type="project_squad", id=squad.id),
            execution_target=ExecutionTargetRef(type="managed_container"),
        ),
    )
    run_view = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="bounded-squad",
    )

    stages = (
        test_db.query(TaskStageRun)
        .filter(TaskStageRun.workflow_run_id == run_view.id)
        .order_by(TaskStageRun.created_at.asc())
        .all()
    )
    assert len(stages) == 3
    assert [stage.status for stage in stages].count("queued") == 1
    assert [stage.status for stage in stages].count("pending") == 2
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.workflow_run_id == run_view.id)
        .count()
        == 1
    )

    for index in range(3):
        current = (
            test_db.query(TaskStageRun)
            .filter(
                TaskStageRun.workflow_run_id == run_view.id,
                TaskStageRun.status == "queued",
            )
            .first()
        )
        assert current
        project_workflow_service.submit_stage_artifact(
            test_db,
            project_id=project.id,
            item_id=task.id,
            run_id=run_view.id,
            stage_id=current.id,
            user_id=test_user.id,
            request=WorkflowArtifactCreate(
                artifact_type="execution_result",
                content={"member": current.target_id},
            ),
        )
        loop_item_execution_service.complete(
            test_db,
            execution_id=current.loop_item_execution_id,
        )
        test_db.expire_all()
        assert test_db.query(LoopItemExecution).filter(
            LoopItemExecution.workflow_run_id == run_view.id
        ).count() == min(index + 2, 3)

    run = test_db.get(TaskWorkflowRun, run_view.id)
    assert run
    assert run.status == "completed"
    assert {
        stage.status
        for stage in test_db.query(TaskStageRun)
        .filter(TaskStageRun.workflow_run_id == run.id)
        .all()
    } == {"passed"}


def test_execution_cannot_pass_without_required_artifact(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    agent = _create_agent(test_db, project, test_user, agent_id="artifact-agent")
    task = _create_task(test_db, project, test_user)
    project_workflow_service.upsert_task_binding(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        request=TaskExecutionBindingUpsert(
            actor=ExecutionActorRef(type="project_agent", id=agent.id),
            execution_target=ExecutionTargetRef(type="managed_container"),
        ),
    )
    run_view = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="missing-artifact",
    )
    stage = (
        test_db.query(TaskStageRun)
        .filter(TaskStageRun.workflow_run_id == run_view.id)
        .one()
    )

    loop_item_execution_service.complete(
        test_db,
        execution_id=stage.loop_item_execution_id,
    )
    test_db.expire_all()

    stage = test_db.get(TaskStageRun, stage.id)
    run = test_db.get(TaskWorkflowRun, run_view.id)
    assert stage
    assert run
    assert stage.status == "failed"
    assert stage.failure_code == "required_artifact_missing"
    assert run.status == "blocked"


def test_human_gate_approval_advances_serial_workflow(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    agent = _create_agent(test_db, project, test_user, agent_id="approval-agent")
    task = _create_task(test_db, project, test_user)
    workflow = project_workflow_service.create_workflow(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=WorkflowDefinitionCreate.model_validate(
            {
                "name": "Approval workflow",
                "stages": [
                    {
                        "key": "build",
                        "name": "Build",
                        "nodes": [
                            {
                                "key": "implement",
                                "name": "Implement",
                                "type": "agent",
                                "actor": {
                                    "type": "project_agent",
                                    "id": agent.id,
                                },
                                "requiredOutputs": ["execution_result"],
                            }
                        ],
                    },
                    {
                        "key": "approve",
                        "name": "Approve",
                        "nodes": [
                            {
                                "key": "human-approval",
                                "name": "Human approval",
                                "type": "human_gate",
                                "condition": "human_approved",
                            }
                        ],
                    },
                ],
            }
        ),
    )
    project_workflow_service.upsert_task_binding(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        request=TaskExecutionBindingUpsert(
            workflow_id=workflow.id,
            execution_target=ExecutionTargetRef(type="managed_container"),
        ),
    )
    run_view = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="approval-flow",
    )
    execution_stage = (
        test_db.query(TaskStageRun)
        .filter(TaskStageRun.workflow_run_id == run_view.id)
        .one()
    )
    project_workflow_service.submit_stage_artifact(
        test_db,
        project_id=project.id,
        item_id=task.id,
        run_id=run_view.id,
        stage_id=execution_stage.id,
        user_id=test_user.id,
        request=WorkflowArtifactCreate(
            artifact_type="execution_result",
            content={"result": "ready"},
        ),
    )
    loop_item_execution_service.complete(
        test_db,
        execution_id=execution_stage.loop_item_execution_id,
    )
    test_db.expire_all()

    approval_stage = (
        test_db.query(TaskStageRun)
        .filter(
            TaskStageRun.workflow_run_id == run_view.id,
            TaskStageRun.node_type == "human_gate",
        )
        .one()
    )
    run = test_db.get(TaskWorkflowRun, run_view.id)
    assert run
    assert run.status == "waiting_approval"
    assert approval_stage.status == "waiting_approval"

    detail = project_workflow_service.approve_stage(
        test_db,
        project_id=project.id,
        item_id=task.id,
        run_id=run.id,
        stage_id=approval_stage.id,
        user_id=test_user.id,
        request=WorkflowAction(version=approval_stage.version),
    )
    assert detail.status == "completed"
    assert detail.artifacts[-1].artifact_type == "approval_decision"


def test_repository_event_advances_ci_and_completes_task(
    test_db: Session,
    test_user: User,
) -> None:
    project = _create_project(test_db, test_user)
    agent = _create_agent(test_db, project, test_user, agent_id="provider-agent")
    task = _create_task(test_db, project, test_user)
    repository = project_workflow_service.create_repository(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=RepositoryBindingCreate(
            provider="github",
            repository_identity="wegent/workflow-test",
            repository_url="https://github.com/wegent/workflow-test.git",
            default_branch="main",
            git_policy={
                "branchTemplate": "feature/{project_key}-{task_id}-{task_slug}"
            },
        ),
    )
    workflow = project_workflow_service.create_workflow(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=WorkflowDefinitionCreate.model_validate(
            {
                "name": "CI workflow",
                "repositoryBindingId": repository.id,
                "stages": [
                    {
                        "key": "build",
                        "name": "Build",
                        "nodes": [
                            {
                                "key": "implement",
                                "name": "Implement",
                                "type": "agent",
                                "actor": {
                                    "type": "project_agent",
                                    "id": agent.id,
                                },
                                "requiredOutputs": ["execution_result"],
                            }
                        ],
                    },
                    {
                        "key": "ci",
                        "name": "CI",
                        "nodes": [
                            {
                                "key": "ci-gate",
                                "name": "CI passed",
                                "type": "ci_gate",
                                "condition": "ci_passed",
                            }
                        ],
                    },
                    {
                        "key": "complete",
                        "name": "Complete",
                        "nodes": [
                            {
                                "key": "complete-task",
                                "name": "Complete task",
                                "type": "complete",
                            }
                        ],
                    },
                ],
            }
        ),
    )
    project_workflow_service.upsert_task_binding(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        request=TaskExecutionBindingUpsert(
            workflow_id=workflow.id,
            repository_binding_id=repository.id,
            execution_target=ExecutionTargetRef(type="managed_container"),
            workspace_mode="git_worktree",
        ),
    )
    run_view = project_workflow_service.start_task_workflow(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
        idempotency_key="provider-flow",
    )
    workspace = (
        test_db.query(TaskWorkspace).filter(TaskWorkspace.loop_item_id == task.id).one()
    )
    link = (
        test_db.query(TaskDevelopmentLink)
        .filter(TaskDevelopmentLink.loop_item_id == task.id)
        .one()
    )
    assert workspace.branch_name.startswith("feature/")
    assert workspace.workspace_path == f"/workspace/{task.id}"
    assert link.workspace_id == workspace.id

    execution_stage = (
        test_db.query(TaskStageRun)
        .filter(
            TaskStageRun.workflow_run_id == run_view.id,
            TaskStageRun.node_type == "agent",
        )
        .one()
    )
    project_workflow_service.submit_stage_artifact(
        test_db,
        project_id=project.id,
        item_id=task.id,
        run_id=run_view.id,
        stage_id=execution_stage.id,
        user_id=test_user.id,
        request=WorkflowArtifactCreate(
            artifact_type="execution_result",
            content={"result": "pushed"},
        ),
    )
    loop_item_execution_service.complete(
        test_db,
        execution_id=execution_stage.loop_item_execution_id,
    )
    test_db.expire_all()
    ci_stage = (
        test_db.query(TaskStageRun)
        .filter(
            TaskStageRun.workflow_run_id == run_view.id,
            TaskStageRun.node_type == "ci_gate",
        )
        .one()
    )
    assert ci_stage.status == "queued"

    event = RepositoryProviderEventInput.model_validate(
        {
            "providerEventId": "check-suite-1",
            "deliveryId": "delivery-1",
            "eventType": "check_suite.completed",
            "branchName": workspace.branch_name,
            "headCommit": "a" * 40,
            "pullRequestId": "123",
            "pullRequestNumber": 123,
            "pullRequestUrl": "https://github.com/wegent/workflow-test/pull/123",
            "pullRequestState": "open",
            "reviewDecision": "approved",
            "mergeableState": "clean",
            "checks": [
                {
                    "id": "unit-tests",
                    "name": "unit-tests",
                    "status": "completed",
                    "conclusion": "success",
                }
            ],
            "reviewThreads": [
                {
                    "id": "thread-1",
                    "commentId": "comment-1",
                    "path": "backend/app/service.py",
                    "line": 42,
                    "side": "right",
                    "author": "reviewer",
                    "body": "Handle this error explicitly.",
                    "url": "https://github.com/wegent/workflow-test/pull/123#discussion_r1",
                    "status": "resolved",
                    "reviewState": "approved",
                }
            ],
        }
    )
    processed = project_workflow_service.process_repository_provider_event(
        test_db,
        binding_id=repository.id,
        project_id=project.id,
        user_id=test_user.id,
        request=event,
    )
    duplicate = project_workflow_service.process_repository_provider_event(
        test_db,
        binding_id=repository.id,
        project_id=project.id,
        user_id=test_user.id,
        request=event,
    )
    test_db.expire_all()

    run = test_db.get(TaskWorkflowRun, run_view.id)
    task = test_db.get(LoopItem, task.id)
    development = project_workflow_service.get_task_development(
        test_db,
        project_id=project.id,
        item_id=task.id,
        user_id=test_user.id,
    )
    assert processed.processing_status == "processed"
    assert duplicate.duplicate
    assert run and run.status == "completed"
    assert task and task.status == "completed"
    assert development[0].ci_state == "success"
    assert development[0].checks[0].conclusion == "success"
    assert development[0].review_threads[0].status == "resolved"
    assert development[0].review_threads[0].path == "backend/app/service.py"


def test_pull_request_actions_persist_provider_state_and_enforce_merge_gates(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _create_project(test_db, test_user)
    task = _create_task(test_db, project, test_user)
    repository = project_workflow_service.create_repository(
        test_db,
        project_id=project.id,
        user_id=test_user.id,
        request=RepositoryBindingCreate(
            provider="github",
            repository_identity="wegent/workflow-test",
            repository_url="https://github.com/wegent/workflow-test.git",
            credential_ref="connector:github",
        ),
    )
    link = TaskDevelopmentLink(
        id=uuid.uuid4().hex,
        loop_item_id=task.id,
        repository_binding_id=repository.id,
        branch_name="feature/provider-actions",
        base_branch="main",
        provider="github",
    )
    test_db.add(link)
    test_db.commit()
    created_state = PullRequestState(
        provider_id="pr-42",
        number=42,
        url="https://github.com/wegent/workflow-test/pull/42",
        state="open",
        draft=True,
        mergeable_state="clean",
        review_decision=None,
        head_commit="a" * 40,
        merged_commit=None,
    )
    monkeypatch.setattr(
        "app.services.project_workflows.service.repository_provider_client"
        ".create_pull_request",
        lambda *args, **kwargs: created_state,
    )

    created = project_workflow_service.create_pull_request(
        test_db,
        project_id=project.id,
        item_id=task.id,
        development_id=link.id,
        user_id=test_user.id,
        request=PullRequestCreate(
            title="Implement provider actions",
            body="Verified implementation",
        ),
    )
    assert created.pull_request_number == 42
    assert created.draft is True

    with pytest.raises(HTTPException, match="CI succeeds"):
        project_workflow_service.merge_pull_request(
            test_db,
            project_id=project.id,
            item_id=task.id,
            development_id=link.id,
            user_id=test_user.id,
            request=PullRequestMerge(version=created.version),
        )

    link = test_db.get(TaskDevelopmentLink, link.id)
    assert link
    link.ci_state = "success"
    link.review_decision = "approved"
    test_db.commit()
    merged_state = PullRequestState(
        provider_id="pr-42",
        number=42,
        url=created.pull_request_url or "",
        state="merged",
        draft=False,
        mergeable_state="clean",
        review_decision="approved",
        head_commit="a" * 40,
        merged_commit="b" * 40,
    )
    monkeypatch.setattr(
        "app.services.project_workflows.service.repository_provider_client"
        ".merge_pull_request",
        lambda *args, **kwargs: merged_state,
    )
    merged = project_workflow_service.merge_pull_request(
        test_db,
        project_id=project.id,
        item_id=task.id,
        development_id=link.id,
        user_id=test_user.id,
        request=PullRequestMerge(version=link.version),
    )
    assert merged.pull_request_state == "merged"
    assert merged.merged_commit == "b" * 40
