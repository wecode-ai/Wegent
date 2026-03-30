# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_emit_error_persists_partial_result_and_blocks():
    """FAILED subtasks should keep partial output generated before the error."""
    from app.services.execution.emitters import StatusUpdatingEmitter

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)

    mock_session_manager = AsyncMock()
    mock_session_manager.get_accumulated_content.return_value = "partial output"
    mock_session_manager.finalize_and_get_blocks.return_value = [
        {"type": "text", "text": "partial output"}
    ]

    mock_db_handler = AsyncMock()

    with (
        patch("app.services.chat.storage.session_manager", mock_session_manager),
        patch("app.services.chat.storage.db.db_handler", mock_db_handler),
        patch.object(emitter, "_publish_task_completed_event", new=AsyncMock()),
    ):
        await emitter.emit_error(task_id=101, subtask_id=202, error="model error")

    mock_db_handler.update_subtask_status.assert_awaited_once_with(
        202,
        "FAILED",
        result={
            "value": "partial output",
            "blocks": [{"type": "text", "text": "partial output"}],
        },
        error="model error",
        executor_name=None,
        executor_namespace=None,
    )
    mock_session_manager.cleanup_streaming_state.assert_awaited_once_with(
        202, task_id=101
    )
