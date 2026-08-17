# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.endpoints.internal import callback as internal_callback
from app.core.events import EventBus, TaskCompletedEvent
from app.models.delivery import LoopItem, ProjectAutomationRule, ProjectAutomationRun
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.router import CommunicationMode, ExecutionRouter
from app.services.project_automation_managed_execution import (
    ManagedTeamExecutionHandle,
    project_automation_managed_execution_service,
)
from shared.models import ExecutionRequest
from shared.models.responses_api import ResponsesAPIStreamEvents


def _managed_task_json(*, subtask_id: int, status: str = "PENDING") -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": "managed-task",
            "namespace": "default",
            "labels": {
                "source": "project_automation",
                "projectAutomationSubtaskId": str(subtask_id),
                "projectAutomationTeamId": "8",
                "projectAutomationRunId": "run-1",
                "projectChatMessageId": "message-1",
                "weworkSpaceProjectId": "project-1",
                "weworkSpaceTaskId": "board-task-1",
            },
        },
        "spec": {
            "title": "Managed task",
            "prompt": "Handle event",
            "teamRef": {"name": "team-a", "namespace": "default"},
            "workspaceRef": {"name": "workspace-a", "namespace": "default"},
        },
        "status": {"status": status, "progress": 0},
    }


@pytest.mark.asyncio
async def test_managed_dispatch_creates_real_task_with_board_labels(monkeypatch):
    task = SimpleNamespace(id=41, json={"metadata": {"labels": {}}})
    user_subtask = SimpleNamespace(id=42)
    assistant_subtask = SimpleNamespace(id=43)
    create_chat_task = AsyncMock(
        return_value=SimpleNamespace(
            task=task,
            user_subtask=user_subtask,
            assistant_subtask=assistant_subtask,
        )
    )
    update_json = MagicMock(
        side_effect=lambda db, *, task, payload: setattr(task, "json", payload)
    )
    enqueue = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.create_chat_task",
        create_chat_task,
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.task_store.update_json",
        update_json,
    )
    monkeypatch.setattr(
        "app.tasks.project_automation_tasks."
        "execute_managed_project_automation.delay",
        enqueue,
    )
    db = MagicMock()
    owner = SimpleNamespace(id=7)
    team = SimpleNamespace(id=8, kind="Team")

    handle = await project_automation_managed_execution_service.dispatch(
        db=db,
        owner=owner,
        team=team,
        prompt="  Triage this board event  ",
        title="Board steward",
        project_id="project-1",
        loop_item_id="board-task-1",
        automation_run_id="run-1",
        project_chat_message_id="message-1",
    )

    assert handle == ManagedTeamExecutionHandle(task_id=41, subtask_id=43)
    params = create_chat_task.await_args.kwargs["params"]
    assert params.device_id is None
    assert params.source == "project_automation"
    assert params.auto_delete_executor == "true"
    assert create_chat_task.await_args.kwargs["message"] == "Triage this board event"
    labels = task.json["metadata"]["labels"]
    assert labels == {
        "source": "project_automation",
        "projectAutomationSubtaskId": "43",
        "projectAutomationTeamId": "8",
        "projectAutomationRunId": "run-1",
        "projectChatMessageId": "message-1",
        "weworkSpaceProjectId": "project-1",
        "weworkSpaceTaskId": "board-task-1",
    }
    db.commit.assert_called_once_with()
    enqueue.assert_called_once_with(
        task_id=41,
        assistant_subtask_id=43,
        user_subtask_id=42,
        team_id=8,
        user_id=7,
        prompt="Triage this board event",
    )


@pytest.mark.asyncio
async def test_board_team_dispatch_uses_native_team_task_and_execution_identity(
    monkeypatch,
):
    task = SimpleNamespace(id=51, json={"metadata": {"labels": {}}})
    result = SimpleNamespace(
        task=task,
        user_subtask=SimpleNamespace(id=52),
        assistant_subtask=SimpleNamespace(id=53),
    )
    create_chat_task = AsyncMock(return_value=result)
    update_json = MagicMock(
        side_effect=lambda db, *, task, payload: setattr(task, "json", payload)
    )
    enqueue = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.create_chat_task",
        create_chat_task,
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.task_store.update_json",
        update_json,
    )
    monkeypatch.setattr(
        "app.tasks.project_automation_tasks."
        "execute_managed_project_automation.delay",
        enqueue,
    )
    execution = SimpleNamespace(
        id=61,
        loop_item_id="board-task-1",
        cloud_project_id="project-1",
        agent_id="robot-9",
        team_id=8,
        executor_owner_user_id=7,
        backend_task_id=None,
    )
    db = MagicMock()
    db.get.side_effect = lambda model, row_id: (
        execution if model is LoopItemExecution and row_id == 61 else None
    )
    owner = SimpleNamespace(id=7)
    agent = SimpleNamespace(
        id="robot-9",
        cloud_project_id="project-1",
        title="Code Reviewer",
        name="code-reviewer",
        status="active",
    )
    team = SimpleNamespace(id=8, kind="Team", name="Review Team", is_active=True)

    handle = await project_automation_managed_execution_service.dispatch_board_team(
        db=db,
        owner=owner,
        agent=agent,
        team=team,
        prompt="  Review the task  ",
        title="Board review",
        project_id="project-1",
        loop_item_id="board-task-1",
        execution_id=61,
    )

    assert handle == ManagedTeamExecutionHandle(
        task_id=51,
        subtask_id=53,
        source="board_team_assignment",
        execution_id=61,
    )
    assert execution.backend_task_id == 51
    assert create_chat_task.await_args.kwargs["commit"] is False
    assert task.json["metadata"]["labels"] == {
        "source": "board_team_assignment",
        "boardTeamExecutionId": "61",
        "boardTeamSubtaskId": "53",
        "boardTeamTeamId": "8",
        "weworkSpaceProjectId": "project-1",
        "weworkSpaceTaskId": "board-task-1",
    }
    activity = db.add.call_args.args[0]
    assert activity.sender_id == "robot-9"
    assert activity.sender_name == "Code Reviewer"
    assert activity.agent_id == "robot-9"
    assert activity.metadata_json["execution_id"] == 61
    enqueue.assert_called_once_with(
        task_id=51,
        assistant_subtask_id=53,
        user_subtask_id=52,
        team_id=8,
        user_id=7,
        prompt="Review the task",
        source="board_team_assignment",
        execution_id=61,
    )


def test_board_runtime_activation_task_marks_worker_failure(monkeypatch):
    from app.tasks.project_automation_tasks import dispatch_board_robot_execution

    db = MagicMock()
    dispatch = AsyncMock(side_effect=RuntimeError("invalid runtime target"))
    fail = MagicMock()
    monkeypatch.setattr(
        "app.tasks.project_automation_tasks.SessionLocal",
        MagicMock(return_value=db),
    )
    monkeypatch.setattr(
        "app.services.board_team_execution.dispatch_board_robot_execution",
        dispatch,
    )
    monkeypatch.setattr(
        "app.services.loop_item_executions.service." "loop_item_execution_service.fail",
        fail,
    )

    with pytest.raises(RuntimeError, match="invalid runtime target"):
        dispatch_board_robot_execution.run(execution_id=61)

    db.rollback.assert_called_once_with()
    fail.assert_called_once_with(
        db,
        execution_id=61,
        error="invalid runtime target",
        termination_reason="wegent_runtime_activation_failed",
    )
    db.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_board_team_completion_updates_only_matching_execution_truth(
    test_db,
    test_user,
    monkeypatch,
):
    team = Kind(
        kind="Team",
        name="board-completion-team",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="board-team-task",
        namespace="default",
        json={"metadata": {"labels": {}}},
    )
    item = LoopItem(
        id="board-team-item",
        cloud_project_id="project-1",
        title="Review board task",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([team, task, item])
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id="project-1",
        executor_owner_user_id=test_user.id,
        team_id=team.id,
        backend_task_id=task.id,
        assigner_user_id=test_user.id,
        execution_environment="managed",
        status="running",
        observed_state="running",
        sync_state="in_sync",
    )
    test_db.add(execution)
    test_db.flush()
    task.json = {
        "metadata": {
            "labels": {
                "source": "board_team_assignment",
                "boardTeamExecutionId": str(execution.id),
                "boardTeamSubtaskId": "53",
                "boardTeamTeamId": str(team.id),
                "weworkSpaceProjectId": "project-1",
                "weworkSpaceTaskId": item.id,
            }
        },
        "status": {"status": "COMPLETED"},
    }
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    monkeypatch.setattr("app.services.board_team_completion.get_db_session", session)
    from app.services.board_team_completion import handle_board_team_task_completed

    await handle_board_team_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=54,
            user_id=test_user.id,
            status="COMPLETED",
            result={"value": "Unrelated completion"},
        )
    )
    test_db.refresh(execution)
    assert execution.status == "running"

    await handle_board_team_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=53,
            user_id=test_user.id,
            status="COMPLETED",
            result={"result": "Review complete"},
        )
    )

    test_db.refresh(execution)
    assert execution.status == "completed"
    assert execution.observed_state == "succeeded"
    assert execution.backend_task_id == task.id


@pytest.mark.asyncio
async def test_board_team_continuation_projects_to_its_comment_without_rewriting_execution(
    test_db,
    test_user,
    monkeypatch,
):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="board-team-continuation",
        namespace="default",
        json={"metadata": {"labels": {}}},
    )
    item = LoopItem(
        id="board-team-continuation-item",
        cloud_project_id="project-1",
        title="Continue board task",
        status="in_review",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([task, item])
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id="project-1",
        executor_owner_user_id=test_user.id,
        team_id=8,
        backend_task_id=task.id,
        assigner_user_id=test_user.id,
        execution_environment="wegent",
        status="completed",
        observed_state="succeeded",
        sync_state="in_sync",
    )
    test_db.add(execution)
    test_db.flush()
    continuation_subtask = Subtask(
        user_id=test_user.id,
        task_id=task.id,
        team_id=8,
        title="Continue board task",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
        progress=100,
    )
    test_db.add(continuation_subtask)
    test_db.flush()
    activity = ProjectChatMessage(
        message_id="continuation-activity",
        client_message_id="continuation-activity",
        project_id="project-1",
        task_id=item.id,
        sender_type="agent",
        sender_id="board-agent-1",
        sender_name="Board Agent",
        message_type="agent_chunk",
        content="",
        metadata_json={
            "execution_id": execution.id,
            "executor_type": "wegent_team",
            "backend_task_id": task.id,
            "backend_subtask_id": continuation_subtask.id,
            "run_status": "running",
        },
        agent_id="board-agent-1",
        runtime_task_id=f"wegent:{task.id}:{continuation_subtask.id}",
        status="streaming",
    )
    test_db.add(activity)
    test_db.flush()
    task.json = {
        "metadata": {
            "labels": {
                "source": "board_team_assignment",
                "boardTeamExecutionId": str(execution.id),
                "boardTeamSubtaskId": "53",
                "boardTeamTeamId": "8",
                "boardTeamActiveSubtaskId": str(continuation_subtask.id),
                "boardTeamActiveMessageId": activity.message_id,
                "weworkSpaceProjectId": "project-1",
                "weworkSpaceTaskId": item.id,
            }
        },
        "status": {"status": "COMPLETED"},
    }
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    push = MagicMock()
    monkeypatch.setattr("app.services.board_team_completion.get_db_session", session)
    monkeypatch.setattr(
        "app.services.board_team_continuation.push_project_chat_message", push
    )
    from app.services.board_team_completion import handle_board_team_task_completed

    await handle_board_team_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=continuation_subtask.id,
            user_id=test_user.id,
            status="COMPLETED",
            result={"value": "继续执行完成"},
        )
    )

    test_db.refresh(activity)
    test_db.refresh(execution)
    assert activity.status == "completed"
    assert activity.content == "继续执行完成"
    assert activity.metadata_json["run_status"] == "completed"
    assert execution.status == "completed"
    assert execution.observed_state == "succeeded"
    push.assert_called_once()


@pytest.mark.asyncio
async def test_board_team_cancel_event_projects_runtime_acknowledged_truth(
    test_db,
    test_user,
    monkeypatch,
):
    team = Kind(
        kind="Team",
        name="board-cancel-team",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="board-cancel-task",
        namespace="default",
        json={"metadata": {"labels": {}}},
    )
    item = LoopItem(
        id="board-cancel-item",
        cloud_project_id="project-1",
        title="Cancel board task",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([team, task, item])
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id="project-1",
        executor_owner_user_id=test_user.id,
        team_id=team.id,
        backend_task_id=task.id,
        assigner_user_id=test_user.id,
        execution_environment="wegent",
        status="running",
        observed_state="running",
        sync_state="in_sync",
    )
    test_db.add(execution)
    test_db.flush()
    task.json = {
        "metadata": {
            "labels": {
                "source": "board_team_assignment",
                "boardTeamExecutionId": str(execution.id),
                "boardTeamSubtaskId": "53",
                "boardTeamTeamId": str(team.id),
                "weworkSpaceProjectId": "project-1",
                "weworkSpaceTaskId": item.id,
            }
        },
        "status": {"status": "CANCELLED"},
    }
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    monkeypatch.setattr("app.services.board_team_completion.get_db_session", session)
    from app.services.board_team_completion import handle_board_team_task_completed

    await handle_board_team_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=53,
            user_id=test_user.id,
            status="CANCELLED",
            result={"value": "Stopped in Wegent"},
        )
    )

    test_db.refresh(execution)
    assert execution.status == "cancelled"
    assert execution.observed_state == "cancelled"
    assert execution.sync_state == "in_sync"
    assert execution.termination_reason == "runtime_cancel_acknowledged"


@pytest.mark.asyncio
async def test_managed_dispatch_projects_broker_enqueue_failure(monkeypatch):
    task = SimpleNamespace(id=71, json={"metadata": {"labels": {}}})
    result = SimpleNamespace(
        task=task,
        user_subtask=SimpleNamespace(id=72),
        assistant_subtask=SimpleNamespace(id=73),
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.create_chat_task",
        AsyncMock(return_value=result),
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.task_store.update_json",
        MagicMock(
            side_effect=lambda db, *, task, payload: setattr(task, "json", payload)
        ),
    )
    monkeypatch.setattr(
        "app.tasks.project_automation_tasks."
        "execute_managed_project_automation.delay",
        MagicMock(side_effect=RuntimeError("broker unavailable")),
    )
    mark_failed = MagicMock()
    project_failed = MagicMock()
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "mark_dispatch_failed",
        mark_failed,
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution."
        "fail_project_automation_dispatch",
        project_failed,
    )
    db = MagicMock()

    with pytest.raises(RuntimeError, match="broker unavailable"):
        await project_automation_managed_execution_service.dispatch(
            db=db,
            owner=SimpleNamespace(id=7),
            team=SimpleNamespace(id=8, kind="Team"),
            prompt="Handle event",
            title="Board steward",
            project_id="project-1",
            loop_item_id="board-task-1",
            automation_run_id="run-1",
            project_chat_message_id="message-1",
        )

    db.commit.assert_called_once_with()
    mark_failed.assert_called_once_with(
        task_id=71,
        user_id=7,
        error="broker unavailable",
    )
    project_failed.assert_called_once_with(
        task_id=71,
        error="broker unavailable",
    )


@pytest.mark.parametrize(
    ("shell_type", "expected_mode"),
    [
        ("Chat", CommunicationMode.SSE),
        ("ClaudeCode", CommunicationMode.HTTP_CALLBACK),
    ],
)
@pytest.mark.asyncio
async def test_managed_execution_builds_explicit_board_mcp_and_has_no_device(
    monkeypatch,
    shell_type,
    expected_mode,
):
    objects = SimpleNamespace(
        task=SimpleNamespace(id=51),
        assistant_subtask=SimpleNamespace(id=53),
        team=SimpleNamespace(id=8),
        user=SimpleNamespace(id=7),
    )
    request = ExecutionRequest(
        task_id=51,
        subtask_id=53,
        device_id="stale-device",
        bot=[{"shell_type": shell_type}],
    )
    build_request = AsyncMock(return_value=request)

    async def dispatch(_request, device_id=None, emitter=None):
        assert _request.device_id is None
        assert device_id is None
        router = ExecutionRouter()
        router.standalone_mode = False
        router.chat_shell_mode = "http"
        assert router.route(_request, device_id).mode == expected_mode
        await emitter.close()

    dispatcher = MagicMock()
    dispatcher.dispatch = AsyncMock(side_effect=dispatch)
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "_load_detached_execution_objects",
        MagicMock(return_value=objects),
    )
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "_claim_pending_execution",
        MagicMock(return_value=True),
    )
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "_execution_is_running",
        MagicMock(return_value=True),
    )
    mark_started = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution."
        "mark_project_automation_dispatch_started",
        mark_started,
    )
    monkeypatch.setattr(
        "app.services.chat.trigger.unified.build_execution_request",
        build_request,
    )
    monkeypatch.setattr(
        "app.services.execution.execution_dispatcher",
        dispatcher,
    )

    dispatched = await project_automation_managed_execution_service.execute(
        handle=ManagedTeamExecutionHandle(task_id=51, subtask_id=53),
        user_subtask_id=52,
        team_id=8,
        user_id=7,
        prompt="Handle event",
    )

    kwargs = build_request.await_args.kwargs
    assert kwargs["device_id"] is None
    assert kwargs["is_subscription"] is False
    assert kwargs["include_wework_space_mcp"] is True
    assert dispatched is True
    mark_started.assert_called_once_with(task_id=51)
    dispatcher.dispatch.assert_awaited_once()


@pytest.mark.parametrize("cancel_acknowledged", [True, False])
@pytest.mark.asyncio
async def test_cancel_routes_real_managed_request_without_device(
    monkeypatch,
    cancel_acknowledged,
):
    task = SimpleNamespace(
        id=61,
        user_id=7,
        json={
            "metadata": {
                "labels": {
                    "source": "project_automation",
                    "projectAutomationSubtaskId": "63",
                    "projectAutomationTeamId": "8",
                }
            },
            "spec": {"prompt": "Handle event"},
        },
    )
    assistant = SimpleNamespace(
        id=63,
        task_id=61,
        user_id=7,
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
    )
    user_subtask = SimpleNamespace(id=62, role=SubtaskRole.USER)
    db = MagicMock()

    @contextmanager
    def session():
        yield db

    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.get_db_session", session
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.task_store.get_by_id",
        MagicMock(return_value=task),
    )
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "_cancel_pending",
        MagicMock(return_value=False),
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution."
        "subtask_store.get_basic_by_id",
        MagicMock(return_value=assistant),
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution."
        "subtask_store.list_by_task_unfiltered",
        MagicMock(return_value=[user_subtask, assistant]),
    )
    objects = SimpleNamespace(
        task=task,
        assistant_subtask=assistant,
        team=SimpleNamespace(id=8),
        user=SimpleNamespace(id=7),
    )
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "_load_detached_execution_objects",
        MagicMock(return_value=objects),
    )
    request = ExecutionRequest(task_id=61, subtask_id=63, device_id="stale-device")
    build_request = AsyncMock(return_value=request)
    monkeypatch.setattr(
        "app.services.chat.trigger.unified.build_execution_request",
        build_request,
    )
    dispatcher = MagicMock()
    dispatcher.cancel = AsyncMock(return_value=cancel_acknowledged)
    monkeypatch.setattr(
        "app.services.execution.execution_dispatcher",
        dispatcher,
    )
    mark_cancelled = MagicMock(return_value=True)
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "_mark_cancelled",
        mark_cancelled,
    )
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution."
        "register_project_automation_task_completion_handler",
        MagicMock(),
    )
    event_bus = MagicMock()
    event_bus.publish = AsyncMock()
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.get_event_bus",
        MagicMock(return_value=event_bus),
    )
    cleanup = AsyncMock()
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cleanup_streaming_state",
        cleanup,
    )

    cancelled = await project_automation_managed_execution_service.cancel(
        task_id=61,
        user_id=7,
    )

    assert cancelled is cancel_acknowledged
    assert request.device_id is None
    assert build_request.await_args.kwargs["include_wework_space_mcp"] is True
    dispatcher.cancel.assert_awaited_once_with(request, device_id=None)
    if cancel_acknowledged:
        mark_cancelled.assert_called_once_with(task_id=61, user_id=7)
        event = event_bus.publish.await_args.args[0]
        assert event.status == "CANCELLED"
        assert event.task_id == 61
        cleanup.assert_awaited_once_with(63, task_id=61)
    else:
        mark_cancelled.assert_not_called()
        event_bus.publish.assert_not_awaited()
        cleanup.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancelled_queued_task_cannot_be_dispatched_by_worker(
    test_db,
    test_user,
    monkeypatch,
):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="queued-managed-task",
        namespace="default",
        json=_managed_task_json(subtask_id=0),
    )
    test_db.add(task)
    test_db.flush()
    assistant = Subtask(
        task_id=task.id,
        user_id=test_user.id,
        team_id=8,
        title="Managed assistant",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.PENDING,
        progress=0,
        completed_at=datetime(1970, 1, 1),
        prompt="Handle event",
        message_id=2,
        sender_type="",
        sender_user_id=0,
        reply_to_subtask_id=0,
    )
    test_db.add(assistant)
    test_db.flush()
    task.json = _managed_task_json(subtask_id=assistant.id)
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.get_db_session", session
    )
    register_handler = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution."
        "register_project_automation_task_completion_handler",
        register_handler,
    )
    event_bus = MagicMock()
    event_bus.publish = AsyncMock()
    monkeypatch.setattr(
        "app.services.project_automation_managed_execution.get_event_bus",
        MagicMock(return_value=event_bus),
    )
    cleanup = AsyncMock()
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cleanup_streaming_state",
        cleanup,
    )
    build_request = AsyncMock()
    monkeypatch.setattr(
        "app.services.chat.trigger.unified.build_execution_request",
        build_request,
    )
    dispatcher = MagicMock()
    dispatcher.cancel = AsyncMock()
    dispatcher.dispatch = AsyncMock()
    monkeypatch.setattr(
        "app.services.execution.execution_dispatcher",
        dispatcher,
    )

    cancelled = await project_automation_managed_execution_service.cancel(
        task_id=task.id,
        user_id=test_user.id,
    )
    dispatched = await project_automation_managed_execution_service.execute(
        handle=ManagedTeamExecutionHandle(
            task_id=task.id,
            subtask_id=assistant.id,
        ),
        user_subtask_id=assistant.id - 1,
        team_id=8,
        user_id=test_user.id,
        prompt="Handle event",
    )

    test_db.expire_all()
    persisted_task = test_db.get(TaskResource, task.id)
    persisted_assistant = test_db.get(Subtask, assistant.id)
    assert cancelled is True
    assert dispatched is False
    assert persisted_task.json["status"]["status"] == "CANCELLED"
    assert persisted_task.json["status"]["progress"] == 100
    assert persisted_assistant.status == SubtaskStatus.CANCELLED
    assert persisted_assistant.progress == 100
    build_request.assert_not_awaited()
    dispatcher.cancel.assert_not_awaited()
    dispatcher.dispatch.assert_not_awaited()
    event = event_bus.publish.await_args.args[0]
    assert event.status == "CANCELLED"
    assert event.subtask_id == assistant.id
    cleanup.assert_awaited_once_with(assistant.id, task_id=task.id)


@pytest.mark.asyncio
async def test_completion_handler_persists_comment_and_run_once(
    test_db,
    test_user,
    monkeypatch,
):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="managed-task",
        namespace="default",
        json={
            "metadata": {
                "labels": {
                    "source": "project_automation",
                    "projectAutomationSubtaskId": "53",
                    "projectAutomationRunId": "run-1",
                    "projectChatMessageId": "message-1",
                    "weworkSpaceProjectId": "project-1",
                    "weworkSpaceTaskId": "board-task-1",
                }
            }
        },
    )
    test_db.add(task)
    test_db.flush()
    board_item = LoopItem(
        id="board-task-1",
        cloud_project_id="project-1",
        title="Board task",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    rule = ProjectAutomationRule(
        id="rule-1",
        cloud_project_id="project-1",
        title="Managed rule",
        description="Choose a robot",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "wegent"},
    )
    run = ProjectAutomationRun(
        id="run-1",
        cloud_project_id="project-1",
        parent_id=rule.id,
        task_id=board_item.id,
        title="Managed run",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    message = ProjectChatMessage(
        message_id="message-1",
        client_message_id="message-1",
        project_id="project-1",
        task_id="board-task-1",
        sender_type="agent",
        sender_id="automation:1",
        sender_name="AI 托管",
        message_type="agent_status",
        content="",
        metadata_json={"automation_run_id": "run-1", "run_status": "running"},
        status="streaming",
    )
    test_db.add_all([board_item, rule, run, message])
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    pushed = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_completion.get_db_session", session
    )
    monkeypatch.setattr(
        "app.services.project_automation_completion.push_project_chat_message",
        pushed,
    )
    from app.services.project_automation_completion import (
        handle_project_automation_task_completed,
    )

    event = TaskCompletedEvent(
        task_id=task.id,
        subtask_id=53,
        user_id=test_user.id,
        status="COMPLETED",
        result={"value": "No suitable project assignee"},
    )
    await handle_project_automation_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=52,
            user_id=test_user.id,
            status="COMPLETED",
            result={"value": "Unrelated user message"},
        )
    )
    test_db.refresh(run)
    test_db.refresh(message)
    assert run.status == "running"
    assert message.status == "streaming"
    pushed.assert_not_called()

    await handle_project_automation_task_completed(event)
    await handle_project_automation_task_completed(event)
    await handle_project_automation_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=53,
            user_id=test_user.id,
            status="CANCELLED",
        )
    )

    test_db.refresh(run)
    test_db.refresh(message)
    assert run.status == "skipped"
    assert run.backend_task_id == task.id
    assert run.completed_at is not None
    assert run.version == 2
    assert message.status == "completed"
    assert message.message_type == "text"
    assert message.content == "No suitable project assignee"
    assert message.metadata_json["backend_task_id"] == task.id
    assert pushed.call_count == 1


@pytest.mark.asyncio
async def test_manager_callback_failure_keeps_completed_member_assignment(
    test_db,
    test_user,
    monkeypatch,
):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="assigned-manager-task",
        namespace="default",
        json={
            "metadata": {
                "labels": {
                    "source": "project_automation",
                    "projectAutomationSubtaskId": "63",
                    "projectAutomationRunId": "assigned-run-1",
                    "projectChatMessageId": "assigned-message-1",
                    "weworkSpaceProjectId": "project-1",
                    "weworkSpaceTaskId": "assigned-board-task-1",
                }
            }
        },
    )
    board_item = LoopItem(
        id="assigned-board-task-1",
        cloud_project_id="project-1",
        title="Assigned board task",
        status="inbox",
        created_by_user_id=test_user.id,
        assignee_user_id=test_user.id,
        metadata_json={},
    )
    rule = ProjectAutomationRule(
        id="assigned-rule-1",
        cloud_project_id="project-1",
        title="Assigned managed rule",
        description="Choose a project member",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "wegent"},
    )
    run = ProjectAutomationRun(
        id="assigned-run-1",
        cloud_project_id="project-1",
        parent_id=rule.id,
        task_id=board_item.id,
        title="Assigned managed run",
        status="succeeded",
        created_by_user_id=test_user.id,
        metadata_json={"activity_message_id": "assigned-message-1"},
    )
    message = ProjectChatMessage(
        message_id="assigned-message-1",
        client_message_id="assigned-message-1",
        project_id="project-1",
        task_id=board_item.id,
        sender_type="agent",
        sender_id="wegent_team:8",
        sender_name="Wegent manager",
        message_type="agent_status",
        content="",
        metadata_json={
            "automation_run_id": run.id,
            "run_status": "running",
            "selected_assignee_type": "user",
            "selected_assignee_id": str(test_user.id),
        },
        status="streaming",
    )
    test_db.add_all([task, board_item, rule, run, message])
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    pushed = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_completion.get_db_session", session
    )
    monkeypatch.setattr(
        "app.services.project_automation_completion.push_project_chat_message",
        pushed,
    )
    from app.services.project_automation_completion import (
        handle_project_automation_task_completed,
    )

    await handle_project_automation_task_completed(
        TaskCompletedEvent(
            task_id=task.id,
            subtask_id=63,
            user_id=test_user.id,
            status="FAILED",
            error="result stream closed",
        )
    )

    test_db.refresh(run)
    test_db.refresh(message)
    assert run.status == "succeeded"
    assert board_item.assignee_user_id == test_user.id
    assert message.status == "completed"
    assert message.content == "AI 调度员已完成分派，但调度结果回传失败。"
    pushed.assert_called_once()


@pytest.mark.asyncio
async def test_executor_callback_projects_managed_parent_comment(
    test_db,
    test_user,
    monkeypatch,
):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="callback-managed-task",
        namespace="default",
        json={
            "metadata": {
                "labels": {
                    "source": "project_automation",
                    "projectAutomationSubtaskId": "73",
                    "projectAutomationRunId": "callback-run-1",
                    "projectChatMessageId": "callback-message-1",
                    "weworkSpaceProjectId": "project-1",
                    "weworkSpaceTaskId": "board-task-1",
                }
            }
        },
    )
    board_item = LoopItem(
        id="board-task-1",
        cloud_project_id="project-1",
        title="Board task",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    rule = ProjectAutomationRule(
        id="callback-rule-1",
        cloud_project_id="project-1",
        title="Callback managed rule",
        description="Choose a robot",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "wegent"},
    )
    run = ProjectAutomationRun(
        id="callback-run-1",
        cloud_project_id="project-1",
        parent_id=rule.id,
        task_id=board_item.id,
        title="Callback managed run",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    message = ProjectChatMessage(
        message_id="callback-message-1",
        client_message_id="callback-message-1",
        project_id="project-1",
        task_id="board-task-1",
        sender_type="agent",
        sender_id="wegent_team:8",
        sender_name="Wegent robot",
        message_type="agent_status",
        content="",
        metadata_json={
            "automation_run_id": "callback-run-1",
            "run_status": "running",
        },
        status="streaming",
    )
    test_db.add_all([task, board_item, rule, run, message])
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    from app.services.project_automation_completion import (
        register_project_automation_task_completion_handler,
    )

    event_bus = EventBus()
    register_project_automation_task_completion_handler(event_bus)
    pushed = MagicMock()
    wrapped_emitter = SimpleNamespace(emit=AsyncMock(), close=AsyncMock())
    collected_result = AsyncMock(
        side_effect=lambda _subtask_id, **kwargs: kwargs.get("result")
    )
    persisted_result = AsyncMock()

    monkeypatch.setattr("app.core.events.get_event_bus", lambda: event_bus)
    monkeypatch.setattr(
        "app.services.project_automation_completion.get_db_session", session
    )
    monkeypatch.setattr(
        "app.services.project_automation_completion.push_project_chat_message",
        pushed,
    )
    monkeypatch.setattr(
        "app.services.execution.emitters.status_updating.collect_completed_result",
        collected_result,
    )
    monkeypatch.setattr(
        "app.services.execution.emitters.status_updating.persist_completed_result",
        persisted_result,
    )
    monkeypatch.setattr(
        StatusUpdatingEmitter,
        "_resolve_owner_user_id",
        lambda _self: test_user.id,
    )
    monkeypatch.setattr(
        internal_callback,
        "_get_task_status_user_id",
        lambda _task_id, _event_type: test_user.id,
    )
    monkeypatch.setattr(
        internal_callback,
        "WebSocketResultEmitter",
        lambda **_kwargs: wrapped_emitter,
    )
    monkeypatch.setattr(
        internal_callback.session_manager,
        "publish_callback_event",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        internal_callback,
        "forward_event_to_channel_callbacks",
        AsyncMock(),
    )

    response = await internal_callback.handle_callback(
        internal_callback.CallbackRequest(
            event_type=ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
            task_id=task.id,
            subtask_id=73,
            data={
                "response": {
                    "output": [
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "No suitable project assignee",
                                }
                            ]
                        }
                    ]
                }
            },
        )
    )

    test_db.refresh(run)
    test_db.refresh(message)
    assert response.status == "ok"
    assert run.status == "skipped"
    assert run.backend_task_id == task.id
    assert message.status == "completed"
    assert message.message_type == "text"
    assert message.content == "No suitable project assignee"
    assert message.metadata_json["backend_task_id"] == task.id
    assert persisted_result.await_args.kwargs["status"] == "COMPLETED"
    assert persisted_result.await_args.kwargs["result"]["value"] == (
        "No suitable project assignee"
    )
    assert wrapped_emitter.emit.await_count == 1
    assert pushed.call_count == 1


def test_worker_start_projects_running_state_once(test_db, test_user, monkeypatch):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="queued-managed-task",
        namespace="default",
        json={
            "metadata": {
                "labels": {
                    "source": "project_automation",
                    "projectAutomationSubtaskId": "53",
                    "projectAutomationRunId": "queued-run-1",
                    "projectChatMessageId": "queued-message-1",
                    "weworkSpaceProjectId": "project-1",
                    "weworkSpaceTaskId": "board-task-1",
                }
            }
        },
    )
    run = ProjectAutomationRun(
        id="queued-run-1",
        cloud_project_id="project-1",
        title="Queued managed run",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    message = ProjectChatMessage(
        message_id="queued-message-1",
        client_message_id="queued-message-1",
        project_id="project-1",
        task_id="board-task-1",
        sender_type="agent",
        sender_id="automation:1",
        sender_name="AI 托管",
        message_type="agent_status",
        content="",
        metadata_json={
            "automation_run_id": "queued-run-1",
            "run_status": "queued",
        },
        status="pending",
    )
    test_db.add_all([task, run, message])
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    pushed = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automation_completion.get_db_session", session
    )
    monkeypatch.setattr(
        "app.services.project_automation_completion.push_project_chat_message",
        pushed,
    )
    from app.services.project_automation_completion import (
        mark_project_automation_dispatch_started,
    )

    assert mark_project_automation_dispatch_started(task_id=task.id) is True
    assert mark_project_automation_dispatch_started(task_id=task.id) is False

    test_db.refresh(run)
    test_db.refresh(message)
    assert run.status == "running"
    assert run.backend_task_id == task.id
    assert run.version == 2
    assert message.status == "streaming"
    assert message.metadata_json["run_status"] == "running"
    assert message.metadata_json["backend_task_id"] == task.id
    assert pushed.call_count == 1


def test_completion_handler_registration_is_idempotent():
    from app.services.project_automation_completion import (
        handle_project_automation_task_completed,
        register_project_automation_task_completion_handler,
    )

    event_bus = EventBus()
    register_project_automation_task_completion_handler(event_bus)
    register_project_automation_task_completion_handler(event_bus)

    assert event_bus._handlers[TaskCompletedEvent] == [
        handle_project_automation_task_completed
    ]


def test_celery_managed_execution_runs_async_service(monkeypatch):
    from app.tasks.project_automation_tasks import execute_managed_project_automation

    execute = AsyncMock(return_value=True)
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "execute",
        execute,
    )
    result = execute_managed_project_automation.run(
        task_id=81,
        assistant_subtask_id=83,
        user_subtask_id=82,
        team_id=8,
        user_id=7,
        prompt="Handle event",
    )

    assert result == {"status": "dispatched", "task_id": 81}
    execute.assert_awaited_once_with(
        handle=ManagedTeamExecutionHandle(task_id=81, subtask_id=83),
        user_subtask_id=82,
        team_id=8,
        user_id=7,
        prompt="Handle event",
    )


def test_celery_managed_execution_reports_cancelled_claim_as_skipped(monkeypatch):
    from app.tasks.project_automation_tasks import execute_managed_project_automation

    execute = AsyncMock(return_value=False)
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "execute",
        execute,
    )
    mark_failed = MagicMock()
    project_failed = MagicMock()
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "mark_dispatch_failed",
        mark_failed,
    )
    monkeypatch.setattr(
        "app.services.project_automation_completion.fail_project_automation_dispatch",
        project_failed,
    )

    result = execute_managed_project_automation.run(
        task_id=91,
        assistant_subtask_id=93,
        user_subtask_id=92,
        team_id=8,
        user_id=7,
        prompt="Handle event",
    )

    assert result == {"status": "skipped", "task_id": 91}
    mark_failed.assert_not_called()
    project_failed.assert_not_called()
