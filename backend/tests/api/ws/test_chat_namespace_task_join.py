# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest

from app.api.ws import chat_namespace
from app.api.ws.chat_namespace import ChatNamespace
from app.api.ws.events import ServerEvents
from app.models.delivery import LoopItem
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource


@pytest.mark.asyncio
async def test_task_join_replays_cached_context_metrics_for_active_stream() -> None:
    """Task join should replay the latest context metrics for active streams."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)
    namespace.enter_room = AsyncMock()
    namespace.emit = AsyncMock()

    cached_metrics = {
        "task_id": 101,
        "subtask_id": 55,
        "phase": "tool_end",
        "context_metrics": {
            "remaining_percent": 42,
        },
        "context_compaction": {
            "type": "summary_compact",
            "status": "started",
        },
    }

    with (
        patch(
            "app.api.ws.chat_namespace.can_access_task", AsyncMock(return_value=True)
        ),
        patch(
            "app.api.ws.chat_namespace.run_sync_in_executor",
            AsyncMock(return_value=[]),
        ),
        patch(
            "app.api.ws.chat_namespace.get_active_streaming",
            AsyncMock(return_value={"subtask_id": 55}),
        ),
        patch(
            "app.api.ws.chat_namespace.session_manager.get_streaming_content",
            AsyncMock(return_value="hello"),
        ),
        patch(
            "app.api.ws.chat_namespace.session_manager.get_blocks",
            AsyncMock(return_value=[]),
        ),
        patch(
            "app.api.ws.chat_namespace.session_manager.get_context_metrics",
            AsyncMock(return_value=cached_metrics),
        ),
    ):
        result = await namespace.on_task_join(
            "sid-1",
            {"task_id": 101, "after_message_id": None},
        )

    assert result["streaming"]["subtask_id"] == 55
    assert result["status_updated"] == cached_metrics
    namespace.emit.assert_awaited_once_with(
        ServerEvents.CHAT_STATUS_UPDATED,
        cached_metrics,
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_wework_task_join_joins_wework_task_room() -> None:
    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(
        return_value={"user_id": 1, "client_origin": "wework"}
    )
    namespace._check_token_expiry = AsyncMock(return_value=False)
    namespace.enter_room = AsyncMock()
    namespace.emit = AsyncMock()

    with (
        patch(
            "app.api.ws.chat_namespace.can_access_task", AsyncMock(return_value=True)
        ),
        patch(
            "app.api.ws.chat_namespace.run_sync_in_executor",
            AsyncMock(return_value=[]),
        ),
        patch(
            "app.api.ws.chat_namespace.get_active_streaming",
            AsyncMock(return_value=None),
        ),
    ):
        result = await namespace.on_task_join(
            "sid-1",
            {"task_id": 101, "after_message_id": None},
        )

    assert result["subtasks"] == []
    namespace.enter_room.assert_awaited_once_with("sid-1", "wework:task:101")


@pytest.mark.asyncio
async def test_chat_cancel_waits_for_runtime_ack_without_faking_terminal_state() -> (
    None
):
    """The request path records intent; Runtime callback owns terminal state."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)
    mark_cancelling_calls = []

    async def run_sync_side_effect(func, *args):
        if func.__name__ == "_get_subtask_for_cancel":
            return {
                "task_id": 101,
                "status": SubtaskStatus.RUNNING,
                "executor_name": "device-local-device",
            }
        if func.__name__ == "_mark_task_and_board_cancelling":
            mark_cancelling_calls.append(args)
            return None
        raise AssertionError(f"Unexpected sync function: {func.__name__}")

    with (
        patch(
            "app.api.ws.chat_namespace.run_sync_in_executor",
            AsyncMock(side_effect=run_sync_side_effect),
        ),
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.cancel",
            AsyncMock(return_value=True),
        ) as cancel_mock,
        patch(
            "app.services.chat.operations.cancel.is_stream_alive",
            AsyncMock(return_value=True),
        ),
    ):
        result = await namespace.on_chat_cancel(
            "sid-1",
            {
                "subtask_id": 55,
                "partial_content": "partial",
                "shell_type": "ClaudeCode",
            },
        )

    assert result == {"success": True}
    assert mark_cancelling_calls == [(55,)]
    cancel_request, device_id = cancel_mock.await_args.args
    assert cancel_request.executor_name == "device-local-device"
    assert device_id == "local-device"


@pytest.mark.asyncio
async def test_chat_cancel_reports_runtime_rejection() -> None:
    """A failed Runtime delivery must not be reported as a successful stop."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)

    async def run_sync_side_effect(func, *args):
        if func.__name__ == "_get_subtask_for_cancel":
            return {
                "task_id": 101,
                "status": SubtaskStatus.RUNNING,
                "executor_name": None,
            }
        if func.__name__ == "_mark_task_and_board_cancelling":
            return None
        raise AssertionError(f"Unexpected sync function: {func.__name__}")

    with (
        patch(
            "app.api.ws.chat_namespace.run_sync_in_executor",
            AsyncMock(side_effect=run_sync_side_effect),
        ),
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.cancel",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.chat.operations.cancel.is_stream_alive",
            AsyncMock(return_value=True),
        ),
    ):
        result = await namespace.on_chat_cancel(
            "sid-1",
            {"subtask_id": 55, "shell_type": "ClaudeCode"},
        )

    assert result == {"error": "Runtime did not acknowledge cancellation"}


@pytest.mark.asyncio
async def test_chat_cancel_finalizes_when_stream_runtime_is_gone() -> None:
    """A dead stream has no consumer for the cancel flag and no terminal
    callback, so the request path must finalize the cancellation itself."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)

    async def run_sync_side_effect(func, *args):
        if func.__name__ == "_get_subtask_for_cancel":
            return {
                "task_id": 101,
                "status": SubtaskStatus.RUNNING,
                "executor_name": None,
            }
        if func.__name__ == "_mark_task_and_board_cancelling":
            return None
        if func.__name__ == "_finalize_stuck_cancellation":
            return [55]
        raise AssertionError(f"Unexpected sync function: {func.__name__}")

    with (
        patch(
            "app.api.ws.chat_namespace.run_sync_in_executor",
            AsyncMock(side_effect=run_sync_side_effect),
        ),
        patch(
            "app.services.execution.dispatcher.execution_dispatcher.cancel",
            AsyncMock(return_value=True),
        ),
        patch(
            "app.services.chat.operations.cancel.is_stream_alive",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.services.chat.operations.cancel.publish_task_cancelled_events",
            AsyncMock(),
        ) as publish_mock,
    ):
        result = await namespace.on_chat_cancel(
            "sid-1",
            {"subtask_id": 55, "shell_type": "Chat"},
        )

    assert result == {"success": True, "finalized": True}
    publish_mock.assert_awaited_once_with(101, [55], 1)


def test_native_cancel_atomically_records_linked_board_intent(
    test_db,
    test_user,
    monkeypatch,
) -> None:
    """The direct Wegent stop path records intent without inventing a terminal."""

    team = Kind(
        kind="Team",
        name="native-cancel-team",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="native-cancel-task",
        namespace="default",
        json={},
    )
    item = LoopItem(
        id="native-cancel-board-item",
        cloud_project_id="project-1",
        title="Native cancellation",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([team, task, item])
    test_db.flush()
    subtask = Subtask(
        user_id=test_user.id,
        task_id=task.id,
        team_id=team.id,
        title="assistant",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
        message_id=2,
        completed_at=datetime(1970, 1, 1),
    )
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        executor_owner_user_id=test_user.id,
        team_id=team.id,
        assigner_user_id=test_user.id,
        execution_environment="wegent",
        status="running",
        observed_state="running",
        sync_state="in_sync",
    )
    test_db.add_all([subtask, execution])
    test_db.flush()
    execution.backend_task_id = task.id
    task.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": task.name,
            "namespace": task.namespace,
            "labels": {
                "source": "board_team_assignment",
                "boardTeamExecutionId": str(execution.id),
                "boardTeamSubtaskId": str(subtask.id),
                "boardTeamTeamId": str(team.id),
                "weworkSpaceProjectId": item.cloud_project_id,
                "weworkSpaceTaskId": item.id,
            },
        },
        "spec": {
            "title": "Native cancellation",
            "prompt": "Stop me",
            "teamRef": {"name": team.name, "namespace": team.namespace},
            "workspaceRef": {
                "name": "native-cancel-workspace",
                "namespace": "default",
            },
        },
        "status": {"status": "RUNNING", "progress": 50},
    }
    test_db.commit()

    @contextmanager
    def session():
        try:
            yield test_db
            test_db.commit()
        except Exception:
            test_db.rollback()
            raise

    monkeypatch.setattr(chat_namespace, "get_db_session", session)

    chat_namespace._mark_task_and_board_cancelling(subtask.id)

    test_db.refresh(task)
    test_db.refresh(subtask)
    test_db.refresh(execution)
    assert task.json["status"]["status"] == "CANCELLING"
    assert task.json["status"]["completedAt"] is None
    assert subtask.status == SubtaskStatus.RUNNING
    assert execution.status == "cancel_requested"
    assert execution.observed_state == "running"
    assert execution.sync_state == "pending"


@pytest.mark.asyncio
async def test_chat_resume_rejects_subtask_from_different_task() -> None:
    """Chat resume should deny cached state access when task/subtask do not match."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace.enter_room = AsyncMock()

    with (
        patch(
            "app.api.ws.chat_namespace.can_access_task",
            AsyncMock(return_value=True),
        ),
        patch(
            "app.api.ws.chat_namespace.run_sync_in_executor",
            AsyncMock(return_value=False),
        ),
        patch(
            "app.api.ws.chat_namespace.session_manager.get_streaming_content",
            AsyncMock(),
        ) as mock_get_streaming_content,
    ):
        result = await namespace.on_chat_resume(
            "sid-1",
            {"task_id": 101, "subtask_id": 55, "offset": 0},
        )

    assert result == {"error": "Access denied"}
    mock_get_streaming_content.assert_not_awaited()


@pytest.mark.asyncio
async def test_finalize_failed_ai_trigger_persists_failed_terminal_state() -> None:
    """Async trigger failures should finalize task state so follow-up is not blocked."""

    collected_result = {
        "blocks": [{"id": "err-block", "type": "output_text", "content": "oops"}],
        "error_type": "generic_error",
    }

    with (
        patch(
            "app.api.ws.chat_namespace.collect_completed_result",
            AsyncMock(return_value=collected_result),
        ) as collect_completed_result,
        patch(
            "app.api.ws.chat_namespace.persist_completed_result",
            AsyncMock(),
        ) as persist_completed_result,
    ):
        await chat_namespace._finalize_failed_ai_trigger(
            task_id=101,
            assistant_subtask_id=55,
            error_message="database failed",
            error_code="generic_error",
        )

    collect_completed_result.assert_awaited_once_with(
        55,
        status="FAILED",
        error_message="database failed",
        error_code="generic_error",
    )
    persist_completed_result.assert_awaited_once_with(
        subtask_id=55,
        task_id=101,
        status="FAILED",
        result=collected_result,
        error="database failed",
    )
