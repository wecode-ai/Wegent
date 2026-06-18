# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from unittest.mock import AsyncMock, call, patch

import pytest

from shared.models import EventType, ExecutionEvent


@pytest.mark.asyncio
async def test_chunk_events_batch_storage_without_blocking_forward(monkeypatch):
    """Streaming chunks should forward immediately and persist as a batch."""
    from app.services.chat.storage.session import StreamContentType
    from app.services.execution.emitters import status_updating
    from app.services.execution.emitters.status_updating import StatusUpdatingEmitter

    monkeypatch.setattr(
        status_updating,
        "STREAMING_STORAGE_FLUSH_INTERVAL_SECONDS",
        3600.0,
        raising=False,
    )

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)
    mock_session_manager = AsyncMock()

    first = ExecutionEvent(
        type=EventType.CHUNK.value,
        task_id=101,
        subtask_id=202,
        content="Hel",
    )
    second = ExecutionEvent(
        type=EventType.CHUNK.value,
        task_id=101,
        subtask_id=202,
        content="lo",
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(first)
        await emitter.emit(second)

        wrapped.emit.assert_has_awaits([call(first), call(second)])
        mock_session_manager.add_stream_content.assert_not_awaited()

        await emitter.close()

    mock_session_manager.add_stream_content.assert_awaited_once_with(
        subtask_id=202,
        content_type=StreamContentType.TEXT,
        content="Hello",
    )


@pytest.mark.asyncio
async def test_done_event_flushes_pending_chunks_before_status_update(monkeypatch):
    """DONE must persist pending chunks before collecting the final result."""
    from app.services.chat.storage.session import StreamContentType
    from app.services.execution.emitters import status_updating
    from app.services.execution.emitters.status_updating import StatusUpdatingEmitter

    monkeypatch.setattr(
        status_updating,
        "STREAMING_STORAGE_FLUSH_INTERVAL_SECONDS",
        3600.0,
        raising=False,
    )

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)
    emitter._handle_done = AsyncMock()
    mock_session_manager = AsyncMock()

    chunk = ExecutionEvent(
        type=EventType.CHUNK.value,
        task_id=101,
        subtask_id=202,
        content="content",
    )
    done = ExecutionEvent(
        type=EventType.DONE.value,
        task_id=101,
        subtask_id=202,
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(chunk)
        await emitter.emit(done)

    mock_session_manager.add_stream_content.assert_awaited_once_with(
        subtask_id=202,
        content_type=StreamContentType.TEXT,
        content="content",
    )
    emitter._handle_done.assert_awaited_once_with(done)


@pytest.mark.asyncio
async def test_runtime_cache_mode_skips_redis_stream_snapshot_writes():
    """Executor runtime cache owns content and block snapshots when advertised."""
    from app.services.execution.emitters import status_updating
    from app.services.execution.emitters.status_updating import StatusUpdatingEmitter

    status_updating._RUNTIME_CACHE_STATUS_ENSURE_TIMES.clear()

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(
        wrapped=wrapped,
        task_id=101,
        subtask_id=202,
        executor_name="executor-1",
        executor_namespace="default",
        runtime_cache={"enabled": True},
    )
    mock_session_manager = AsyncMock()

    chunk = ExecutionEvent(
        type=EventType.CHUNK.value,
        task_id=101,
        subtask_id=202,
        content="content",
    )
    tool_start = ExecutionEvent(
        type=EventType.TOOL_START.value,
        task_id=101,
        subtask_id=202,
        tool_use_id="tool-1",
        tool_name="Bash",
        tool_input={"command": "pwd"},
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(chunk)
        await emitter.emit(tool_start)
        await emitter.close()

    mock_session_manager.add_stream_content.assert_not_awaited()
    mock_session_manager.add_tool_block.assert_not_awaited()
    mock_session_manager.update_task_streaming_runtime_cache.assert_awaited_once_with(
        task_id=101,
        subtask_id=202,
        executor_name="executor-1",
        executor_namespace="default",
        runtime_cache={"enabled": True},
    )
    wrapped.emit.assert_has_awaits([call(chunk), call(tool_start)])


@pytest.mark.asyncio
async def test_done_event_waits_for_in_progress_background_flush(monkeypatch):
    """Terminal handling must wait if the scheduled Redis flush already started."""
    from app.services.execution.emitters import status_updating
    from app.services.execution.emitters.status_updating import StatusUpdatingEmitter

    monkeypatch.setattr(
        status_updating,
        "STREAMING_STORAGE_FLUSH_INTERVAL_SECONDS",
        0.0,
        raising=False,
    )

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)
    emitter._handle_done = AsyncMock()
    mock_session_manager = AsyncMock()
    flush_started = asyncio.Event()
    release_flush = asyncio.Event()

    async def add_stream_content(**_kwargs):
        flush_started.set()
        await release_flush.wait()

    mock_session_manager.add_stream_content.side_effect = add_stream_content

    chunk = ExecutionEvent(
        type=EventType.CHUNK.value,
        task_id=101,
        subtask_id=202,
        content="content",
    )
    done = ExecutionEvent(
        type=EventType.DONE.value,
        task_id=101,
        subtask_id=202,
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(chunk)
        await asyncio.wait_for(flush_started.wait(), timeout=1.0)

        done_task = asyncio.create_task(emitter.emit(done))
        await asyncio.sleep(0)

        emitter._handle_done.assert_not_awaited()

        release_flush.set()
        await done_task

    emitter._handle_done.assert_awaited_once_with(done)


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


@pytest.mark.asyncio
async def test_interactive_form_tool_result_persists_render_payload_on_real_tool_block():
    from app.services.execution.emitters import StatusUpdatingEmitter

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)
    mock_session_manager = AsyncMock()

    event = ExecutionEvent(
        type=EventType.TOOL_RESULT.value,
        task_id=101,
        subtask_id=202,
        tool_use_id="tool-real-1",
        tool_name="interactive_wegent-interactive-form-question_interactive_form_question",
        tool_input={
            "questions": [
                {
                    "id": "genre",
                    "question": "Genre?",
                    "input_type": "choice",
                    "options": [{"label": "Fantasy", "value": "fantasy"}],
                }
            ]
        },
        tool_output={
            "__silent_exit__": True,
            "__deferred_user_input__": True,
            "success": True,
            "status": "waiting_for_user_response",
        },
        data={
            "tool_protocol": "mcp_call",
            "server_label": "wegent-interactive-form-question",
            "status": "completed",
        },
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(event)

    mock_session_manager.update_tool_block_status.assert_awaited_once_with(
        subtask_id=202,
        tool_use_id="tool-real-1",
        status="done",
        tool_output={
            "__silent_exit__": True,
            "__deferred_user_input__": True,
            "success": True,
            "status": "waiting_for_user_response",
        },
        tool_input={
            "questions": [
                {
                    "id": "genre",
                    "question": "Genre?",
                    "input_type": "choice",
                    "options": [{"label": "Fantasy", "value": "fantasy"}],
                }
            ]
        },
        render_payload={
            "type": "interactive_form_question",
            "task_id": 101,
            "subtask_id": 202,
            "questions": [
                {
                    "id": "genre",
                    "question": "Genre?",
                    "input_type": "choice",
                    "options": [
                        {
                            "label": "Fantasy",
                            "value": "fantasy",
                            "recommended": False,
                        }
                    ],
                    "multi_select": False,
                    "required": True,
                    "default": None,
                    "placeholder": None,
                }
            ],
        },
        tool_protocol="mcp_call",
        server_label="wegent-interactive-form-question",
    )


@pytest.mark.asyncio
async def test_thinking_events_persist_thinking_blocks():
    from app.services.chat.storage.session import StreamContentType
    from app.services.execution.emitters import StatusUpdatingEmitter

    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)
    mock_session_manager = AsyncMock()

    thinking_event = ExecutionEvent(
        type=EventType.THINKING.value,
        task_id=101,
        subtask_id=202,
        content="Reasoning chunk.",
    )

    with patch("app.services.chat.storage.session_manager", mock_session_manager):
        await emitter.emit(thinking_event)
        await emitter.close()

    mock_session_manager.add_stream_content.assert_awaited_once_with(
        subtask_id=202,
        content_type=StreamContentType.THINKING,
        content="Reasoning chunk.",
    )
