# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.task import TaskResource
from app.schemas.project_chat import ProjectChatWegentContinuation
from app.services import board_team_continuation
from app.services.board_team_continuation import board_team_continuation_service


@pytest.mark.asyncio
async def test_reply_creates_one_native_follow_up_and_reuses_it_on_ack_retry(
    test_db,
    test_user,
    monkeypatch,
):
    team = Kind(
        kind="Team",
        name="continuation-team",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    agent = ProjectChatAgent(
        id="continuation-agent",
        cloud_project_id="project-1",
        title="Continuation Agent",
        name="Continuation Agent",
        created_by_user_id=test_user.id,
        status="active",
        metadata_json={"runtime": "wegent"},
    )
    item = LoopItem(
        id="continuation-item",
        cloud_project_id="project-1",
        title="Continue native task",
        status="in_review",
        assignee_agent_id=agent.id,
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    native_task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="native-continuation-task",
        namespace="default",
        json={
            "metadata": {
                "labels": {
                    "source": "board_team_assignment",
                    "boardTeamSubtaskId": "53",
                }
            },
            "spec": {"title": "Native board task"},
            "status": {"status": "COMPLETED"},
        },
    )
    test_db.add_all([team, agent, item, native_task])
    test_db.flush()
    agent.metadata_json = {"runtime": "wegent", "wegent_team_id": team.id}
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id="project-1",
        agent_id=agent.id,
        team_id=team.id,
        backend_task_id=native_task.id,
        executor_owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        execution_environment="wegent",
        status="completed",
        observed_state="succeeded",
        sync_state="in_sync",
    )
    test_db.add(execution)
    test_db.flush()
    initial_response = ProjectChatMessage(
        message_id="initial-wegent-response",
        client_message_id="initial-wegent-response",
        project_id="project-1",
        task_id=item.id,
        sender_type="agent",
        sender_id=f"wegent_team:{team.id}",
        sender_name="Continuation Team",
        message_type="text",
        content="Please confirm.",
        metadata_json={
            "execution_id": execution.id,
            "executor_type": "wegent_team",
            "backend_task_id": native_task.id,
        },
        status="completed",
    )
    trigger = ProjectChatMessage(
        message_id="user-confirmation",
        client_message_id="user-confirmation",
        project_id="project-1",
        task_id=item.id,
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        message_type="text",
        content="确认",
        metadata_json={},
        reply_to_message_id=initial_response.message_id,
        thread_root_message_id=initial_response.message_id,
        status="completed",
    )
    test_db.add_all([initial_response, trigger])
    test_db.commit()

    created = SimpleNamespace(
        task=native_task,
        user_subtask=SimpleNamespace(id=70),
        assistant_subtask=SimpleNamespace(id=71),
    )
    create_storage = MagicMock(
        return_value=SimpleNamespace(creation=created),
    )
    task_creation_output = SimpleNamespace()
    build_output = MagicMock(return_value=task_creation_output)
    run_side_effects = AsyncMock()
    enqueue = MagicMock()

    @contextmanager
    def test_db_session():
        yield test_db

    async def run_inline(function, *args):
        return function(*args)

    monkeypatch.setattr(
        board_team_continuation.project_chat_service,
        "_require_scope",
        MagicMock(return_value=item),
    )
    monkeypatch.setattr(
        board_team_continuation,
        "_create_task_and_subtasks_storage",
        create_storage,
    )
    monkeypatch.setattr(
        board_team_continuation,
        "build_nonblocking_task_creation_output",
        build_output,
    )
    monkeypatch.setattr(
        board_team_continuation,
        "run_task_creation_side_effects",
        run_side_effects,
    )
    monkeypatch.setattr(
        board_team_continuation,
        "get_db_session",
        test_db_session,
    )
    monkeypatch.setattr(
        board_team_continuation,
        "run_sync_in_executor",
        run_inline,
    )
    monkeypatch.setattr(
        "app.tasks.project_automation_tasks.execute_board_team_continuation.delay",
        enqueue,
    )
    request = ProjectChatWegentContinuation(
        project_id="project-1",
        task_id=item.id,
        trigger_message_id=trigger.message_id,
        agent_id=agent.id,
    )

    first = await board_team_continuation_service.start_nonblocking(
        user_id=test_user.id,
        request=request,
    )
    repeated = await board_team_continuation_service.start_nonblocking(
        user_id=test_user.id,
        request=request,
    )
    second_trigger = ProjectChatMessage(
        message_id="user-second-confirmation",
        client_message_id="user-second-confirmation",
        project_id="project-1",
        task_id=item.id,
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        message_type="text",
        content="再次确认",
        metadata_json={},
        reply_to_message_id=initial_response.message_id,
        thread_root_message_id=initial_response.message_id,
        status="completed",
    )
    test_db.add(second_trigger)
    test_db.commit()
    with pytest.raises(HTTPException, match="previous Wegent continuation") as exc:
        await board_team_continuation_service.start_nonblocking(
            user_id=test_user.id,
            request=ProjectChatWegentContinuation(
                project_id="project-1",
                task_id=item.id,
                trigger_message_id=second_trigger.message_id,
                agent_id=agent.id,
            ),
        )

    assert first.created is True
    assert repeated.created is False
    assert exc.value.status_code == 409
    assert repeated.message.message_id == first.message.message_id
    assert first.message.status == "pending"
    assert first.message.agent_id == agent.id
    assert first.message.runtime_address is None
    assert first.message.metadata["backend_task_id"] == native_task.id
    assert first.message.metadata["backend_subtask_id"] == 71
    assert create_storage.call_count == 1
    assert create_storage.call_args.kwargs["task_id"] == native_task.id
    assert create_storage.call_args.kwargs["message"] == "确认"
    assert create_storage.call_args.kwargs["commit"] is False
    build_output.assert_called_once()
    run_side_effects.assert_awaited_once_with(task_creation_output)
    enqueue.assert_called_once_with(
        task_id=native_task.id,
        assistant_subtask_id=71,
        user_subtask_id=70,
        team_id=team.id,
        user_id=test_user.id,
        prompt="确认",
    )
    labels = native_task.json["metadata"]["labels"]
    assert labels["boardTeamActiveSubtaskId"] == "71"
    assert labels["boardTeamActiveMessageId"] == first.message.message_id
