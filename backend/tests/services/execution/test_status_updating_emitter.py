# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest

from shared.models import EventType, ExecutionEvent


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
        patch(
            "app.services.chat.trigger.lifecycle._get_existing_subtask_result",
            new=AsyncMock(return_value={}),
        ),
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


@pytest.mark.asyncio
async def test_emit_error_merges_persisted_and_new_blocks():
    """FAILED subtasks should preserve persisted blocks and append new ones."""
    from app.services.execution.emitters import StatusUpdatingEmitter

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)

    mock_session_manager = AsyncMock()
    mock_session_manager.get_accumulated_content.return_value = "partial output"
    mock_session_manager.finalize_and_get_blocks.return_value = [
        {"id": "new", "type": "text", "text": "new output"}
    ]

    mock_db_handler = AsyncMock()

    with (
        patch("app.services.chat.storage.session_manager", mock_session_manager),
        patch("app.services.chat.storage.db.db_handler", mock_db_handler),
        patch(
            "app.services.chat.trigger.lifecycle._get_existing_subtask_result",
            new=AsyncMock(
                return_value={
                    "blocks": [{"id": "old", "type": "text", "text": "old output"}]
                }
            ),
        ),
        patch.object(emitter, "_publish_task_completed_event", new=AsyncMock()),
    ):
        await emitter.emit_error(task_id=101, subtask_id=202, error="model error")

    mock_db_handler.update_subtask_status.assert_awaited_once_with(
        202,
        "FAILED",
        result={
            "value": "partial output",
            "blocks": [
                {"id": "old", "type": "text", "text": "old output"},
                {"id": "new", "type": "text", "text": "new output"},
            ],
        },
        error="model error",
        executor_name=None,
        executor_namespace=None,
    )


@pytest.mark.asyncio
async def test_tool_events_persist_mcp_protocol_metadata():
    from app.services.execution.emitters import StatusUpdatingEmitter

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)

    mock_session_manager = AsyncMock()

    tool_start = ExecutionEvent(
        type=EventType.TOOL_START.value,
        task_id=101,
        subtask_id=202,
        tool_use_id="call_mcp_1",
        tool_name="search_docs",
        tool_input={"query": "SSE timeout"},
        data={
            "tool_protocol": "mcp_call",
            "server_label": "wegent-knowledge",
            "display_name": "search_docs",
        },
    )
    tool_done = ExecutionEvent(
        type=EventType.TOOL_RESULT.value,
        task_id=101,
        subtask_id=202,
        tool_use_id="call_mcp_1",
        tool_name="search_docs",
        tool_input={"query": "SSE timeout"},
        tool_output="ok",
        data={
            "tool_protocol": "mcp_call",
            "server_label": "wegent-knowledge",
            "status": "completed",
        },
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(tool_start)
        await emitter.emit(tool_done)

    mock_session_manager.add_tool_block.assert_awaited_once_with(
        subtask_id=202,
        tool_use_id="call_mcp_1",
        tool_name="search_docs",
        tool_input={"query": "SSE timeout"},
        display_name="search_docs",
        tool_protocol="mcp_call",
        server_label="wegent-knowledge",
    )
    mock_session_manager.update_tool_block_status.assert_awaited_once_with(
        subtask_id=202,
        tool_use_id="call_mcp_1",
        status="done",
        tool_output="ok",
        tool_input={"query": "SSE timeout"},
        tool_protocol="mcp_call",
        server_label="wegent-knowledge",
    )
