# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest

from app.api.ws.chat_namespace import ChatNamespace
from app.api.ws.events import ServerEvents
from app.models.subtask import SubtaskStatus


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
    namespace.emit.assert_awaited_once_with(
        ServerEvents.CHAT_STATUS_UPDATED,
        cached_metrics,
        to="sid-1",
    )


@pytest.mark.asyncio
async def test_chat_cancel_cleans_cached_streaming_state() -> None:
    """Cancelling a stream should remove refresh recovery cache immediately."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)
    mark_cancelled_calls = []

    async def run_sync_side_effect(func, *args):
        if func.__name__ == "_get_subtask_for_cancel":
            return {
                "task_id": 101,
                "status": SubtaskStatus.RUNNING,
                "executor_name": "device-local-device",
            }
        if func.__name__ == "_mark_subtask_and_task_cancelled":
            mark_cancelled_calls.append(args)
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
        ),
        patch(
            "app.services.chat.trigger.lifecycle.collect_completed_result",
            AsyncMock(
                return_value={
                    "value": "collected output",
                    "blocks": [{"type": "thinking", "content": "collected thought"}],
                }
            ),
        ) as collect_completed_result,
        patch(
            "app.api.ws.chat_namespace.session_manager.cleanup_streaming_state",
            AsyncMock(),
        ) as cleanup_streaming_state,
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
    collect_completed_result.assert_awaited_once_with(55, status="CANCELLED")
    assert mark_cancelled_calls == [
        (
            55,
            {
                "value": "collected output",
                "blocks": [{"type": "thinking", "content": "collected thought"}],
            },
        )
    ]
    cleanup_streaming_state.assert_awaited_once_with(55, task_id=101)


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
