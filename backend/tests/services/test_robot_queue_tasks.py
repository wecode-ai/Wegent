# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for the unified robot queue dispatcher."""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.project_workflow import (
    ProjectRepositoryBinding,
    TaskDevelopmentLink,
    TaskStageRun,
    TaskWorkflowArtifact,
    TaskWorkflowRun,
    TaskWorkspace,
)
from app.models.user import User
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)
from app.tasks.robot_queue_tasks import (
    _apply_workflow_runtime_context,
    _cleanup_completed_workflow_resources,
    _dispatch_execution,
    _dispatch_managed_container,
)


@pytest.fixture(autouse=True)
def _fake_run_event_wait(monkeypatch):
    """Keep dispatch tests off the real Redis run-event channel."""

    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.wait_for_run_event",
        lambda *args, **kwargs: "response.created",
    )


def _make_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"DISP{uuid.uuid4().hex[:6].upper()}",
        name="Dispatch project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_agent(db: Session, project: CloudProject, user: User) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Dispatch Bot",
        name="Dispatch Bot",
        status="active",
        created_by_user_id=user.id,
        device_id="local-device",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "system_prompt": "Verify before reporting.",
            "execution_mode": "auto",
            "execution_environment": "local",
            "visibility": "public",
        },
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


def _make_execution(
    db: Session, project: CloudProject, agent: ProjectChatAgent, user: User
) -> LoopItemExecution:
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Run me",
        description="Build the landing page.",
        status="inbox",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        agent=agent,
        assigner_user_id=user.id,
        environment="local",
        execution_device_id="local-device",
        priority="medium",
    )
    db.commit()
    db.refresh(execution)
    return execution


def test_dispatch_execution_uses_app_codex_channel_and_writes_back_ids(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id="local-device",
        environment="local",
    )
    assert claimed is not None
    execution = claimed

    emit_rpc = AsyncMock(return_value={"emitted": True})
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
    ):
        import asyncio

        asyncio.run(_dispatch_execution(test_db, execution))

    assert online.await_count == 1
    emit_rpc.assert_awaited_once()
    kwargs = emit_rpc.await_args.kwargs
    assert kwargs["method"] == "runtime.tasks.create"
    assert kwargs["device_id"] == "local-device"
    payload = kwargs["payload"]
    assert payload["taskId"] == f"codex-queue-{execution.id}"
    assert payload["executionRequest"]["task_id"] == f"codex-queue-{execution.id}"
    assert payload["executionRequest"]["subtask_id"] == (
        f"codex-queue-{execution.id}-assistant"
    )
    assert payload["message"]
    # The message is the robot role description; the AI reads the task itself
    # through wework_space instead of receiving the task content inline.
    assert "你是 Dispatch Bot，这个项目任务的 AI 执行者。" in payload["message"]
    assert "Verify before reporting." in payload["message"]
    assert "Build the landing page" not in payload["message"]
    assert "get_board_item" in payload["additionalContext"]["projectChat"]["value"]

    test_db.refresh(execution)
    assert execution.runtime_device_id == "local-device"
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"
    assert execution.status == "running"


def test_registered_device_dispatches_wegent_team_without_project_agent(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Run Wegent Team",
        description="Use the selected Team.",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(item)
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent_id="",
        actor_type="wegent_team",
        actor_id="42",
        actor_snapshot={
            "type": "wegent_team",
            "teamId": 42,
            "namespace": "default",
            "name": "Developer",
            "userId": test_user.id,
        },
        execution_target_type="registered_device",
        execution_target_id="local-device",
        execution_environment="local",
        execution_device_id="local-device",
        assigner_user_id=test_user.id,
        status="running",
    )
    test_db.add(execution)
    test_db.commit()
    test_db.refresh(execution)

    payload = {
        "taskId": "placeholder",
        "executionRequest": {
            "task_id": "placeholder",
            "subtask_id": "placeholder-assistant",
            "bot": [{"id": 1, "shell_type": "codex"}],
        },
    }
    emit_rpc = AsyncMock(return_value={"emitted": True})
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            online,
        ),
        patch(
            "app.tasks.robot_queue_tasks._build_wegent_team_runtime_payload",
            return_value=("Team prompt", payload),
        ) as build_team_payload,
    ):
        import asyncio

        asyncio.run(_dispatch_execution(test_db, execution))

    build_team_payload.assert_called_once()
    emitted = emit_rpc.await_args.kwargs["payload"]
    assert emitted["taskId"] == f"codex-queue-{execution.id}"
    assert emitted["executionRequest"]["task_id"] == f"codex-queue-{execution.id}"
    test_db.refresh(execution)
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"


def test_workflow_runtime_context_injects_workspace_contract_and_artifacts(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Implement from plan",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    repository = ProjectRepositoryBinding(
        id=uuid.uuid4().hex,
        cloud_project_id=str(project.id),
        provider="github",
        repository_identity="wegent-ai/Wegent",
        repository_url="https://github.com/wegent-ai/Wegent.git",
        default_branch="main",
        created_by_user_id=test_user.id,
    )
    workspace = TaskWorkspace(
        id=uuid.uuid4().hex,
        loop_item_id=item.id,
        repository_binding_id=repository.id,
        execution_target_type="registered_device",
        execution_target_id="local-device",
        workspace_path="/workspace/worktrees/123/Wegent",
        workspace_kind="git_worktree",
        branch_name="feature/WEG-123-runtime",
        base_branch="main",
        status="ready",
    )
    run = TaskWorkflowRun(
        id=uuid.uuid4().hex,
        loop_item_id=item.id,
        repository_binding_id=repository.id,
        workflow_definition_snapshot={"stages": []},
        execution_target_type="registered_device",
        execution_target_id="local-device",
        execution_target_snapshot={"type": "registered_device", "id": "local-device"},
        status="running",
        started_by_id=str(test_user.id),
        idempotency_key=uuid.uuid4().hex,
    )
    stage = TaskStageRun(
        id=uuid.uuid4().hex,
        workflow_run_id=run.id,
        group_key="develop",
        node_key="implement",
        node_type="agent",
        target_type="project_agent",
        target_id=agent.id,
        target_snapshot={"type": "project_agent", "id": agent.id},
        execution_target_type="registered_device",
        execution_target_id="local-device",
        workspace_id=workspace.id,
        status="running",
        input_snapshot={
            "workflowNode": {
                "prompt_template": "Implement the approved plan.",
            },
            "inputArtifacts": ["implementation_plan"],
            "requiredOutputs": ["code_change_summary", "test_report"],
        },
    )
    artifact = TaskWorkflowArtifact(
        id=uuid.uuid4().hex,
        workflow_run_id=run.id,
        stage_run_id=stage.id,
        artifact_type="implementation_plan",
        schema_version=1,
        content_json={"steps": ["edit", "test"]},
    )
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent_id=agent.id,
        actor_type="project_agent",
        actor_id=agent.id,
        execution_target_type="registered_device",
        execution_target_id="local-device",
        execution_environment="local",
        execution_device_id="local-device",
        assigner_user_id=test_user.id,
        status="running",
        workflow_run_id=run.id,
        stage_run_id=stage.id,
    )
    test_db.add_all([item, repository, workspace, run, stage, artifact, execution])
    test_db.commit()
    payload = {
        "message": "old",
        "executionRequest": {
            "prompt": "old",
            "standalone_chat_workspace": True,
        },
    }

    import asyncio

    asyncio.run(
        _apply_workflow_runtime_context(
            test_db,
            execution=execution,
            payload=payload,
            user_id=test_user.id,
        )
    )

    request = payload["executionRequest"]
    assert request["workspace_source"] == "git_worktree"
    assert request["project_workspace_path"] == workspace.workspace_path
    assert request["git_url"] == repository.repository_url
    assert request["standalone_chat_workspace"] is False
    contract = payload["additionalContext"]["projectWorkflowStage"]["value"]
    assert contract["branchName"] == "feature/WEG-123-runtime"
    assert contract["requiredOutputs"] == ["code_change_summary", "test_report"]
    assert contract["artifacts"][0]["content"] == {"steps": ["edit", "test"]}


def test_managed_container_dispatch_writes_runtime_stage_linkage(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Run in managed container",
        description="Provision an isolated coding environment.",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    run = TaskWorkflowRun(
        id=uuid.uuid4().hex,
        loop_item_id=item.id,
        workflow_definition_snapshot={"stages": []},
        execution_target_type="managed_container",
        execution_target_snapshot={"type": "managed_container"},
        status="running",
        started_by_id=str(test_user.id),
        idempotency_key=uuid.uuid4().hex,
    )
    stage = TaskStageRun(
        id=uuid.uuid4().hex,
        workflow_run_id=run.id,
        group_key="develop",
        node_key="implement",
        node_type="agent",
        target_type="project_agent",
        target_id=agent.id,
        target_snapshot={
            "type": "project_agent",
            "id": agent.id,
            "timeoutSeconds": 600,
        },
        execution_target_type="managed_container",
        status="running",
        input_snapshot={"requiredOutputs": ["execution_result"]},
    )
    test_db.add_all([item, run, stage])
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent_id=agent.id,
        actor_type="project_agent",
        actor_id=agent.id,
        actor_snapshot=stage.target_snapshot,
        execution_target_type="managed_container",
        execution_environment="cloud",
        execution_device_id="managed-container:default",
        assigner_user_id=test_user.id,
        status="running",
        workflow_run_id=run.id,
        stage_run_id=stage.id,
    )
    test_db.add(execution)
    test_db.flush()
    stage.loop_item_execution_id = execution.id
    test_db.commit()

    client = SimpleNamespace(
        create_sandbox=AsyncMock(
            return_value=(SimpleNamespace(sandbox_id="sandbox-123"), None)
        ),
        execute_sandbox=AsyncMock(return_value=({"execution_id": "runtime-456"}, None)),
    )
    with patch(
        "app.services.execution.get_executor_runtime_client",
        return_value=client,
    ):
        import asyncio

        asyncio.run(_dispatch_managed_container(test_db, execution))

    client.create_sandbox.assert_awaited_once()
    client.execute_sandbox.assert_awaited_once()
    test_db.refresh(execution)
    test_db.refresh(stage)
    assert execution.runtime_device_id == "sandbox-123"
    assert execution.runtime_task_id == "runtime-456"
    assert stage.runtime_instance_id == "sandbox-123"
    assert stage.runtime_task_id == "runtime-456"
    assert stage.status == "running"


def test_completed_workflow_cleanup_removes_managed_sandbox(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Merged workflow",
        description="Clean its managed container.",
        status="completed",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    repository = ProjectRepositoryBinding(
        id=uuid.uuid4().hex,
        cloud_project_id=str(project.id),
        provider="github",
        repository_identity="wegent/wegent",
        repository_url="https://github.com/wegent/wegent.git",
        default_branch="main",
        execution_target_type="managed_container",
        created_by_user_id=test_user.id,
    )
    workspace = TaskWorkspace(
        id=uuid.uuid4().hex,
        loop_item_id=item.id,
        repository_binding_id=repository.id,
        execution_target_type="managed_container",
        workspace_path="/workspace/task",
        workspace_kind="git_worktree",
        branch_name="feature/merged",
        base_branch="main",
        status="released",
        cleanup_policy="after_merge",
    )
    link = TaskDevelopmentLink(
        id=uuid.uuid4().hex,
        loop_item_id=item.id,
        repository_binding_id=repository.id,
        workspace_id=workspace.id,
        branch_name=workspace.branch_name,
        base_branch="main",
        provider="github",
        pull_request_state="merged",
    )
    run = TaskWorkflowRun(
        id=uuid.uuid4().hex,
        loop_item_id=item.id,
        repository_binding_id=repository.id,
        workflow_definition_snapshot={"stages": []},
        execution_target_type="managed_container",
        execution_target_snapshot={"type": "managed_container"},
        status="completed",
        started_by_id=str(test_user.id),
        idempotency_key=uuid.uuid4().hex,
    )
    stage = TaskStageRun(
        id=uuid.uuid4().hex,
        workflow_run_id=run.id,
        group_key="develop",
        node_key="implement",
        node_type="agent",
        execution_target_type="managed_container",
        status="passed",
        runtime_instance_id="sandbox-cleanup-1",
    )
    test_db.add_all([item, repository, workspace, link, run, stage])
    test_db.commit()
    client = SimpleNamespace(delete_sandbox=AsyncMock(return_value=(True, None)))

    with patch(
        "app.services.execution.get_executor_runtime_client",
        return_value=client,
    ):
        import asyncio

        cleaned = asyncio.run(_cleanup_completed_workflow_resources(test_db))

    test_db.refresh(workspace)
    assert cleaned == 1
    assert workspace.status == "cleaned"
    assert workspace.workspace_path == ""
    client.delete_sandbox.assert_awaited_once_with("sandbox-cleanup-1")


def test_dispatch_execution_fails_when_executor_never_starts_session(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    """A dispatched run whose executor never starts a codex session must raise
    before any streaming comment is created, so the run never shows a fake
    "AI 执行" card.

    Regression: the emit was fire-and-forget with no acceptance signal, so an
    executor that never started the task still produced a running execution
    and an empty streaming message ("只创建评论、不创建会话").
    """

    from app.services.project_chat.service import project_chat_service

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id="local-device",
        environment="local",
    )
    assert claimed is not None

    emit_rpc = AsyncMock(return_value={"emitted": True})
    online = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.wait_for_run_event",
        lambda *args, **kwargs: None,
    )
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
    ):
        import asyncio

        with pytest.raises(RuntimeError, match="did not start a codex session"):
            asyncio.run(_dispatch_execution(test_db, execution))

    # No streaming agent message may exist for the task.
    assert (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.task_id == claimed.loop_item_id,
            ProjectChatMessage.sender_type == "agent",
        )
        .count()
        == 0
    )


def test_queue_scan_dispatches_local_and_cloud_runs_through_same_internal_emit(
    test_db: Session, test_user: User
) -> None:
    """Local and cloud device runs must be pushed by the backend through the
    same internal runtime RPC channel; the App is not required to start them."""

    import asyncio
    from contextlib import contextmanager
    from unittest.mock import AsyncMock, patch

    project = _make_project(test_db, test_user)
    local_agent = _make_agent(test_db, project, test_user)
    local_execution = _make_execution(test_db, project, local_agent, test_user)

    cloud_agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Cloud Bot",
        name="Cloud Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="cloud-device-1",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "system_prompt": "Cloud verify.",
            "execution_mode": "auto",
            "execution_environment": "cloud",
            "visibility": "public",
        },
    )
    test_db.add(cloud_agent)
    test_db.commit()
    test_db.refresh(cloud_agent)
    cloud_execution = _make_execution(test_db, project, cloud_agent, test_user)
    cloud_execution.execution_environment = "cloud"
    cloud_execution.execution_device_id = "cloud-device-1"
    test_db.commit()

    emit_rpc = AsyncMock(return_value={"emitted": True, "accepted": True})
    online = AsyncMock(return_value=True)

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            online,
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
    ):
        from app.tasks.robot_queue_tasks import _dispatch_queued_executions

        asyncio.run(_dispatch_queued_executions(test_db))

    assert (
        emit_rpc.await_count == 2
    ), f"expected one emit per device, got {emit_rpc.await_count}"
    devices = {call.kwargs["device_id"] for call in emit_rpc.await_args_list}
    assert devices == {"local-device", "cloud-device-1"}

    test_db.refresh(local_execution)
    test_db.refresh(cloud_execution)
    assert local_execution.status == "running"
    assert cloud_execution.status == "running"
    assert local_execution.runtime_task_id == f"codex-queue-{local_execution.id}"
    assert cloud_execution.runtime_task_id == f"codex-queue-{cloud_execution.id}"


def test_queue_scan_falls_back_to_creator_online_when_device_owner_offline(
    test_db: Session, test_user: User
) -> None:
    """Dispatch must use the robot creator's identity when the Kind device
    owner is offline but the creator's App is online (mixed dev accounts)."""

    import asyncio
    from contextlib import contextmanager
    from unittest.mock import AsyncMock, patch

    owner = User(
        user_name="deviceowner",
        password_hash="x",
        email="owner@example.com",
        is_active=True,
    )
    test_db.add(owner)
    test_db.commit()
    test_db.refresh(owner)
    test_db.add(
        Kind(
            kind="Device",
            name="local-device",
            namespace="default",
            user_id=owner.id,
            is_active=True,
            json={},
        )
    )
    test_db.commit()

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)

    emit_rpc = AsyncMock(return_value={"emitted": True, "accepted": True})

    async def online(user_id: int, device_id: str):
        return user_id == test_user.id

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            side_effect=online,
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
    ):
        from app.tasks.robot_queue_tasks import _dispatch_queued_executions

        asyncio.run(_dispatch_queued_executions(test_db))

    assert emit_rpc.await_count == 1, "dispatch should still happen for creator"
    assert emit_rpc.await_args.kwargs["user_id"] == test_user.id
    test_db.refresh(execution)
    assert execution.status == "running"


def test_execute_robot_task_advances_claimed_and_dispatches(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1
    execution = claimed[0]

    emit_rpc = AsyncMock(
        return_value={
            "emitted": True,
            "accepted": True,
            "result": {"taskId": f"codex-queue-{execution.id}"},
        }
    )
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(execution.id)

    assert result["status"] == "dispatched"
    test_db.refresh(execution)
    assert execution.status == "running"
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"
    emit_rpc.assert_awaited_once()


def test_execute_robot_task_skips_reclaimed_execution(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1
    # The lease watchdog reclaimed it back to queued before the subtask ran.
    claimed[0].status = "queued"
    test_db.commit()

    emit_rpc = AsyncMock(return_value={"emitted": True})
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed[0].id)

    assert result["status"] == "skipped"
    emit_rpc.assert_not_awaited()


def test_execute_robot_task_fails_and_requeues(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1

    emit_rpc = AsyncMock(return_value={"emitted": False})
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed[0].id)

    assert result["status"] == "requeued"
    assert result["reason"] == "device_emit_rejected"
    test_db.refresh(claimed[0])
    assert claimed[0].status == "queued"
    assert claimed[0].retry_attempt == 0
    assert claimed[0].execution_note == "device_emit_rejected"
    assert "Device did not accept the runtime RPC" in claimed[0].error_message


def test_execute_robot_task_requeues_offline_without_consuming_retries(
    test_db: Session, test_user: User
) -> None:
    """A device that drops between claim and dispatch must stay queued for the
    next scan instead of terminally failing after the configured retries."""

    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1

    online = AsyncMock(return_value=False)
    emit_rpc = AsyncMock(return_value={"emitted": True})
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed[0].id)

    assert result["status"] == "requeued"
    assert result["reason"] == "device_offline"
    emit_rpc.assert_not_awaited()
    test_db.refresh(claimed[0])
    assert claimed[0].status == "queued"
    assert claimed[0].retry_attempt == 0
    assert claimed[0].execution_note == "device_offline"
    assert "went offline before dispatch" in claimed[0].error_message


def test_local_dispatch_never_uses_another_users_shared_device(
    test_db: Session, test_user: User
) -> None:
    """Robots bound to a generic device id such as "local-device" must only run
    on the creator's own device, even when another user's same-named device is
    online and appears earlier in the Device kinds table."""

    import asyncio
    from contextlib import contextmanager
    from unittest.mock import AsyncMock, patch

    other = User(
        user_name="other-device-owner",
        password_hash="x",
        email="other@example.com",
        is_active=True,
    )
    test_db.add(other)
    test_db.commit()
    test_db.refresh(other)
    # The stranger's Device row is inserted first; a global first() lookup
    # would resolve to this user.
    test_db.add(
        Kind(
            kind="Device",
            name="local-device",
            namespace="default",
            user_id=other.id,
            is_active=True,
            json={},
        )
    )
    test_db.commit()

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)

    emit_rpc = AsyncMock(return_value={"emitted": True, "accepted": True})

    async def online(user_id: int, device_id: str):
        # Only the stranger's device is online; the creator's is offline.
        return user_id == other.id

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            side_effect=online,
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
    ):
        from app.tasks.robot_queue_tasks import _dispatch_queued_executions

        asyncio.run(_dispatch_queued_executions(test_db))

    emit_rpc.assert_not_awaited()
    test_db.refresh(execution)
    assert execution.status == "queued"


def test_emit_runtime_rpc_uses_configured_internal_url(monkeypatch) -> None:
    """The internal emit must use BACKEND_INTERNAL_URL, never a hardcoded
    localhost port; production pods listen on a different port than dev."""

    import asyncio

    import httpx

    from app.core.config import settings
    from app.tasks.robot_queue_tasks import _emit_runtime_rpc

    captured: dict[str, str] = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"emitted": True}

    class FakeClient:
        def __init__(self, **kwargs):
            captured["base_url"] = kwargs["base_url"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path: str, **kwargs):
            captured["path"] = path
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(
        settings, "BACKEND_INTERNAL_URL", "https://internal.example.com/api"
    )

    result = asyncio.run(
        _emit_runtime_rpc(
            user_id=86,
            device_id="local-device",
            method="runtime.tasks.create",
            payload={"taskId": "codex-queue-1"},
        )
    )

    assert result == {"emitted": True}
    assert captured["base_url"] == "https://internal.example.com/api"
    assert captured["path"] == "/internal/robot-queue/emit-runtime-rpc"


def test_loop_item_response_exposes_terminal_execution_error(
    test_db: Session, test_user: User
) -> None:
    """Task detail responses must keep the newest run visible after it fails,
    including its error message, so the UI can show why execution stopped."""

    from app.services.loop_items.service import loop_item_service

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    loop_item_execution_service.fail(
        test_db,
        execution_id=execution.id,
        error="Device went offline before dispatch",
        requeue_infra=True,
    )

    values = loop_item_service.response_values(
        test_db, test_db.get(LoopItem, execution.loop_item_id), test_user.id
    )

    assert values["execution_id"] == execution.id
    assert values["execution_state"] == "queued"
    assert values["execution_error"] == "Device went offline before dispatch"
