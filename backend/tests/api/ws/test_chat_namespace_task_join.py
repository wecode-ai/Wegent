# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest

from app.api.ws.chat_namespace import ChatNamespace
from app.api.ws.events import ServerEvents


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
