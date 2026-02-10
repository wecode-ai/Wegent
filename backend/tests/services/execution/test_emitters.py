# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for result emitters.

Tests the unified ResultEmitter interface and all implementations.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import EventType, ExecutionEvent


class TestWebSocketResultEmitter:
    """Tests for WebSocketResultEmitter."""

    @pytest.mark.asyncio
    async def test_emit_start(self):
        """Test emitting start event."""
        from app.services.execution.emitters import WebSocketResultEmitter

        with patch("app.services.chat.ws_emitter.get_ws_emitter") as mock_get:
            mock_ws = AsyncMock()
            mock_get.return_value = mock_ws

            emitter = WebSocketResultEmitter(task_id=1, subtask_id=1)
            await emitter.emit_start(task_id=1, subtask_id=1, message_id=100)

            mock_ws.emit_chat_start.assert_called_once_with(
                task_id=1,
                subtask_id=1,
                message_id=100,
            )

    @pytest.mark.asyncio
    async def test_emit_chunk(self):
        """Test emitting chunk event."""
        from app.services.execution.emitters import WebSocketResultEmitter

        with patch("app.services.chat.ws_emitter.get_ws_emitter") as mock_get:
            mock_ws = AsyncMock()
            mock_get.return_value = mock_ws

            emitter = WebSocketResultEmitter(task_id=1, subtask_id=1)
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="Hello", offset=0)

            mock_ws.emit_chat_chunk.assert_called_once()
            call_kwargs = mock_ws.emit_chat_chunk.call_args[1]
            assert call_kwargs["task_id"] == 1
            assert call_kwargs["subtask_id"] == 1
            assert call_kwargs["content"] == "Hello"
            assert call_kwargs["offset"] == 0

    @pytest.mark.asyncio
    async def test_emit_done(self):
        """Test emitting done event."""
        from app.services.execution.emitters import WebSocketResultEmitter

        with patch("app.services.chat.ws_emitter.get_ws_emitter") as mock_get:
            mock_ws = AsyncMock()
            mock_get.return_value = mock_ws

            emitter = WebSocketResultEmitter(task_id=1, subtask_id=1)
            await emitter.emit_done(task_id=1, subtask_id=1, result={"value": "test"})

            mock_ws.emit_chat_done.assert_called_once()

    @pytest.mark.asyncio
    async def test_emit_error(self):
        """Test emitting error event."""
        from app.services.execution.emitters import WebSocketResultEmitter

        with patch("app.services.chat.ws_emitter.get_ws_emitter") as mock_get:
            mock_ws = AsyncMock()
            mock_get.return_value = mock_ws

            emitter = WebSocketResultEmitter(task_id=1, subtask_id=1)
            await emitter.emit_error(task_id=1, subtask_id=1, error="Test error")

            mock_ws.emit_chat_error.assert_called_once()

    @pytest.mark.asyncio
    async def test_emit_without_ws_emitter(self):
        """Test emitting when WebSocket emitter is not available."""
        from app.services.execution.emitters import WebSocketResultEmitter

        with patch("app.services.chat.ws_emitter.get_ws_emitter") as mock_get:
            mock_get.return_value = None

            emitter = WebSocketResultEmitter(task_id=1, subtask_id=1)
            # Should not raise exception
            await emitter.emit_start(task_id=1, subtask_id=1)


class TestSSEResultEmitter:
    """Tests for SSEResultEmitter."""

    @pytest.mark.asyncio
    async def test_emit_and_stream(self):
        """Test emitting events and streaming them."""
        from app.services.execution.emitters import SSEResultEmitter

        emitter = SSEResultEmitter(task_id=1, subtask_id=1)

        # Emit events in background
        async def emit_events():
            await emitter.emit_start(task_id=1, subtask_id=1)
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="Hello", offset=0)
            await emitter.emit_chunk(
                task_id=1, subtask_id=1, content=" World", offset=5
            )
            await emitter.emit_done(task_id=1, subtask_id=1)

        # Start emitting
        emit_task = asyncio.create_task(emit_events())

        # Collect events
        events = []
        async for event in emitter.stream():
            events.append(event)
            if event.type == EventType.DONE.value:
                break

        await emit_task

        assert len(events) == 4
        assert events[0].type == EventType.START.value
        assert events[1].type == EventType.CHUNK.value
        assert events[1].content == "Hello"
        assert events[2].type == EventType.CHUNK.value
        assert events[2].content == " World"
        assert events[3].type == EventType.DONE.value

    @pytest.mark.asyncio
    async def test_collect(self):
        """Test collecting all events."""
        from app.services.execution.emitters import SSEResultEmitter

        emitter = SSEResultEmitter(task_id=1, subtask_id=1)

        # Emit events in background
        async def emit_events():
            await emitter.emit_start(task_id=1, subtask_id=1)
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="Hello", offset=0)
            await emitter.emit_chunk(
                task_id=1, subtask_id=1, content=" World", offset=5
            )
            await emitter.emit_done(task_id=1, subtask_id=1)

        emit_task = asyncio.create_task(emit_events())

        content, final_event = await emitter.collect()

        await emit_task

        assert content == "Hello World"
        assert final_event is not None
        assert final_event.type == EventType.DONE.value

    @pytest.mark.asyncio
    async def test_stream_sse_format(self):
        """Test streaming in SSE format."""
        from app.services.execution.emitters import SSEResultEmitter

        emitter = SSEResultEmitter(task_id=1, subtask_id=1, format_sse=True)

        async def emit_events():
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="Test", offset=0)
            await emitter.emit_done(task_id=1, subtask_id=1)

        emit_task = asyncio.create_task(emit_events())

        sse_data = []
        async for data in emitter.stream_sse():
            sse_data.append(data)
            if "done" in data:
                break

        await emit_task

        assert len(sse_data) == 2
        assert sse_data[0].startswith("data: ")
        assert "chunk" in sse_data[0]


class TestCallbackResultEmitter:
    """Tests for CallbackResultEmitter."""

    @pytest.mark.asyncio
    async def test_emit_callback(self):
        """Test emitting via HTTP callback."""
        from app.services.execution.emitters import CallbackResultEmitter

        emitter = CallbackResultEmitter(
            task_id=1,
            subtask_id=1,
            callback_url="http://test.com/callback",
        )

        with patch.object(emitter, "_get_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_client.post.return_value = mock_response
            mock_get_client.return_value = mock_client

            await emitter.emit_start(task_id=1, subtask_id=1)

            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            assert call_args[0][0] == "http://test.com/callback"

        await emitter.close()

    @pytest.mark.asyncio
    async def test_emit_callback_failure(self):
        """Test handling callback failure."""
        from app.services.execution.emitters import CallbackResultEmitter

        emitter = CallbackResultEmitter(
            task_id=1,
            subtask_id=1,
            callback_url="http://test.com/callback",
        )

        with patch.object(emitter, "_get_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 500
            mock_client.post.return_value = mock_response
            mock_get_client.return_value = mock_client

            # Should not raise exception
            await emitter.emit_start(task_id=1, subtask_id=1)

        await emitter.close()


class TestBatchCallbackEmitter:
    """Tests for BatchCallbackEmitter."""

    @pytest.mark.asyncio
    async def test_batch_emit(self):
        """Test batching events."""
        from app.services.execution.emitters import BatchCallbackEmitter

        emitter = BatchCallbackEmitter(
            task_id=1,
            subtask_id=1,
            callback_url="http://test.com/callback",
            batch_size=3,
        )

        with patch.object(emitter, "_get_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_client.post.return_value = mock_response
            mock_get_client.return_value = mock_client

            # Emit 2 events (less than batch size)
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="A", offset=0)
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="B", offset=1)

            # Should not have sent yet
            mock_client.post.assert_not_called()

            # Emit 3rd event (reaches batch size)
            await emitter.emit_chunk(task_id=1, subtask_id=1, content="C", offset=2)

            # Should have sent batch
            mock_client.post.assert_called_once()

        await emitter.close()

    @pytest.mark.asyncio
    async def test_flush_on_terminal_event(self):
        """Test flushing on terminal event."""
        from app.services.execution.emitters import BatchCallbackEmitter

        emitter = BatchCallbackEmitter(
            task_id=1,
            subtask_id=1,
            callback_url="http://test.com/callback",
            batch_size=10,
        )

        with patch.object(emitter, "_get_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_client.post.return_value = mock_response
            mock_get_client.return_value = mock_client

            await emitter.emit_chunk(task_id=1, subtask_id=1, content="A", offset=0)
            await emitter.emit_done(task_id=1, subtask_id=1)

            # Should have flushed on done event
            mock_client.post.assert_called_once()

        await emitter.close()


class TestCompositeResultEmitter:
    """Tests for CompositeResultEmitter."""

    @pytest.mark.asyncio
    async def test_emit_to_multiple(self):
        """Test emitting to multiple emitters."""
        from app.services.execution.emitters import CompositeResultEmitter

        emitter1 = AsyncMock()
        emitter2 = AsyncMock()

        composite = CompositeResultEmitter([emitter1, emitter2])

        event = ExecutionEvent.create(
            EventType.CHUNK,
            task_id=1,
            subtask_id=1,
            content="test",
        )

        await composite.emit(event)

        emitter1.emit.assert_called_once_with(event)
        emitter2.emit.assert_called_once_with(event)

    @pytest.mark.asyncio
    async def test_partial_failure(self):
        """Test handling partial failure."""
        from app.services.execution.emitters import CompositeResultEmitter

        emitter1 = AsyncMock()
        emitter1.emit.side_effect = Exception("Emitter 1 error")

        emitter2 = AsyncMock()

        composite = CompositeResultEmitter([emitter1, emitter2])

        event = ExecutionEvent.create(
            EventType.CHUNK,
            task_id=1,
            subtask_id=1,
            content="test",
        )

        # Should not raise exception
        await composite.emit(event)

        # Emitter 2 should still be called
        emitter2.emit.assert_called_once_with(event)

    @pytest.mark.asyncio
    async def test_close_all(self):
        """Test closing all emitters."""
        from app.services.execution.emitters import CompositeResultEmitter

        emitter1 = AsyncMock()
        emitter2 = AsyncMock()

        composite = CompositeResultEmitter([emitter1, emitter2])

        await composite.close()

        emitter1.close.assert_called_once()
        emitter2.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_add_remove_emitter(self):
        """Test adding and removing emitters."""
        from app.services.execution.emitters import CompositeResultEmitter

        emitter1 = AsyncMock()
        emitter2 = AsyncMock()

        composite = CompositeResultEmitter([emitter1])
        assert len(composite.emitters) == 1

        composite.add_emitter(emitter2)
        assert len(composite.emitters) == 2

        composite.remove_emitter(emitter1)
        assert len(composite.emitters) == 1
        assert composite.emitters[0] == emitter2


class TestResultEmitterFactory:
    """Tests for ResultEmitterFactory."""

    def test_create_websocket_emitter(self):
        """Test creating WebSocket emitter."""
        from app.services.execution.emitters import (
            EmitterType,
            ResultEmitterFactory,
            WebSocketResultEmitter,
        )

        emitter = ResultEmitterFactory.create(
            EmitterType.WEBSOCKET,
            task_id=1,
            subtask_id=1,
            user_id=100,
        )

        assert isinstance(emitter, WebSocketResultEmitter)
        assert emitter.task_id == 1
        assert emitter.subtask_id == 1
        assert emitter.user_id == 100

    def test_create_sse_emitter(self):
        """Test creating SSE emitter."""
        from app.services.execution.emitters import (
            EmitterType,
            ResultEmitterFactory,
            SSEResultEmitter,
        )

        emitter = ResultEmitterFactory.create(
            EmitterType.SSE,
            task_id=1,
            subtask_id=1,
        )

        assert isinstance(emitter, SSEResultEmitter)

    def test_create_callback_emitter(self):
        """Test creating callback emitter."""
        from app.services.execution.emitters import (
            CallbackResultEmitter,
            EmitterType,
            ResultEmitterFactory,
        )

        emitter = ResultEmitterFactory.create(
            EmitterType.CALLBACK,
            task_id=1,
            subtask_id=1,
            callback_url="http://test.com/callback",
        )

        assert isinstance(emitter, CallbackResultEmitter)
        assert emitter.callback_url == "http://test.com/callback"

    def test_create_callback_emitter_without_url(self):
        """Test creating callback emitter without URL raises error."""
        from app.services.execution.emitters import EmitterType, ResultEmitterFactory

        with pytest.raises(ValueError, match="callback_url is required"):
            ResultEmitterFactory.create(
                EmitterType.CALLBACK,
                task_id=1,
                subtask_id=1,
            )

    def test_create_composite_emitter(self):
        """Test creating composite emitter."""
        from app.services.execution.emitters import (
            CompositeResultEmitter,
            ResultEmitterFactory,
        )

        emitter = ResultEmitterFactory.create_composite(
            task_id=1,
            subtask_id=1,
            emitter_configs=[
                {"type": "websocket", "user_id": 100},
                {"type": "sse"},
            ],
        )

        assert isinstance(emitter, CompositeResultEmitter)
        assert len(emitter.emitters) == 2

    def test_create_for_dispatch_mode(self):
        """Test creating emitter for dispatch mode."""
        from app.services.execution.emitters import (
            ResultEmitterFactory,
            SSEResultEmitter,
            WebSocketResultEmitter,
        )

        ws_emitter = ResultEmitterFactory.create_for_dispatch_mode(
            "websocket",
            task_id=1,
            subtask_id=1,
        )
        assert isinstance(ws_emitter, WebSocketResultEmitter)

        sse_emitter = ResultEmitterFactory.create_for_dispatch_mode(
            "sse",
            task_id=1,
            subtask_id=1,
        )
        assert isinstance(sse_emitter, SSEResultEmitter)

    def test_create_for_unknown_dispatch_mode(self):
        """Test creating emitter for unknown dispatch mode raises error."""
        from app.services.execution.emitters import ResultEmitterFactory

        with pytest.raises(ValueError, match="Unknown dispatch mode"):
            ResultEmitterFactory.create_for_dispatch_mode(
                "unknown",
                task_id=1,
                subtask_id=1,
            )


class TestDirectSSEEmitter:
    """Tests for DirectSSEEmitter."""

    @pytest.mark.asyncio
    async def test_stream_from_upstream(self):
        """Test streaming from upstream source."""
        from app.services.execution.emitters import DirectSSEEmitter

        async def upstream_events():
            yield ExecutionEvent.create(EventType.START, task_id=1, subtask_id=1)
            yield ExecutionEvent.create(
                EventType.CHUNK, task_id=1, subtask_id=1, content="Hello"
            )
            yield ExecutionEvent.create(EventType.DONE, task_id=1, subtask_id=1)

        emitter = DirectSSEEmitter(
            task_id=1,
            subtask_id=1,
            upstream=upstream_events(),
        )

        events = []
        async for event in emitter.stream():
            events.append(event)

        assert len(events) == 3
        assert events[0].type == EventType.START.value
        assert events[1].type == EventType.CHUNK.value
        assert events[2].type == EventType.DONE.value

    @pytest.mark.asyncio
    async def test_collect_from_upstream(self):
        """Test collecting from upstream source."""
        from app.services.execution.emitters import DirectSSEEmitter

        async def upstream_events():
            yield ExecutionEvent.create(EventType.START, task_id=1, subtask_id=1)
            yield ExecutionEvent.create(
                EventType.CHUNK, task_id=1, subtask_id=1, content="Hello"
            )
            yield ExecutionEvent.create(
                EventType.CHUNK, task_id=1, subtask_id=1, content=" World"
            )
            yield ExecutionEvent.create(EventType.DONE, task_id=1, subtask_id=1)

        emitter = DirectSSEEmitter(
            task_id=1,
            subtask_id=1,
            upstream=upstream_events(),
        )

        content, final_event = await emitter.collect()

        assert content == "Hello World"
        assert final_event is not None
        assert final_event.type == EventType.DONE.value


class TestQueueBasedEmitter:
    """Tests for QueueBasedEmitter base class."""

    @pytest.mark.asyncio
    async def test_closed_emitter_drops_events(self):
        """Test that closed emitter drops events."""
        from app.services.execution.emitters import SSEResultEmitter

        emitter = SSEResultEmitter(task_id=1, subtask_id=1)
        await emitter.close()

        # Should not raise, but event should be dropped
        await emitter.emit_chunk(task_id=1, subtask_id=1, content="Test", offset=0)

        # Queue should be empty except for termination signal
        assert emitter._closed is True


class TestSubscriptionResultEmitter:
    """Tests for SubscriptionResultEmitter."""

    @pytest.mark.asyncio
    async def test_emit_chunk_accumulates_content(self):
        """Test that chunk events accumulate content."""
        from app.services.execution.emitters import SubscriptionResultEmitter

        emitter = SubscriptionResultEmitter(
            task_id=1,
            subtask_id=1,
            execution_id=100,
        )

        await emitter.emit_chunk(task_id=1, subtask_id=1, content="Hello", offset=0)
        await emitter.emit_chunk(task_id=1, subtask_id=1, content=" World", offset=5)

        assert emitter._accumulated_content == "Hello World"

        await emitter.close()

    @pytest.mark.asyncio
    async def test_emit_done_updates_status(self):
        """Test that done event updates BackgroundExecution status."""
        from app.services.execution.emitters import SubscriptionResultEmitter

        status_callback_called = False
        callback_status = None
        callback_content = None

        async def on_status_changed(status: str, content: str, is_silent: bool):
            nonlocal status_callback_called, callback_status, callback_content
            status_callback_called = True
            callback_status = status
            callback_content = content

        emitter = SubscriptionResultEmitter(
            task_id=1,
            subtask_id=1,
            execution_id=100,
            on_status_changed=on_status_changed,
        )

        # Accumulate some content
        await emitter.emit_chunk(
            task_id=1, subtask_id=1, content="Test result", offset=0
        )

        # Mock the _update_execution_status method directly
        with patch.object(
            emitter, "_update_execution_status", new_callable=AsyncMock
        ) as mock_update:
            with patch.object(
                emitter, "_check_subtask_silent_exit", new_callable=AsyncMock
            ) as mock_check:
                mock_check.return_value = False

                await emitter.emit_done(task_id=1, subtask_id=1)

                # Verify status update was called
                mock_update.assert_called_once()
                call_kwargs = mock_update.call_args[1]
                assert call_kwargs["status"] == "COMPLETED"

        # Verify callback was called
        assert status_callback_called
        assert callback_status == "COMPLETED"
        assert callback_content == "Test result"

        await emitter.close()

    @pytest.mark.asyncio
    async def test_emit_error_updates_status(self):
        """Test that error event updates BackgroundExecution status."""
        from app.services.execution.emitters import SubscriptionResultEmitter

        emitter = SubscriptionResultEmitter(
            task_id=1,
            subtask_id=1,
            execution_id=100,
        )

        # Mock the _update_execution_status method directly
        with patch.object(
            emitter, "_update_execution_status", new_callable=AsyncMock
        ) as mock_update:
            await emitter.emit_error(
                task_id=1, subtask_id=1, error="Test error message"
            )

            # Verify status update was called with FAILED
            mock_update.assert_called_once()
            call_kwargs = mock_update.call_args[1]
            assert call_kwargs["status"] == "FAILED"
            assert "Test error message" in call_kwargs["error_message"]

        await emitter.close()

    @pytest.mark.asyncio
    async def test_emit_cancelled_updates_status(self):
        """Test that cancelled event updates BackgroundExecution status."""
        from app.services.execution.emitters import SubscriptionResultEmitter

        emitter = SubscriptionResultEmitter(
            task_id=1,
            subtask_id=1,
            execution_id=100,
        )

        # Mock the _update_execution_status method directly
        with patch.object(
            emitter, "_update_execution_status", new_callable=AsyncMock
        ) as mock_update:
            # Use emit() with CANCELLED event type
            cancelled_event = ExecutionEvent.create(
                EventType.CANCELLED,
                task_id=1,
                subtask_id=1,
            )
            await emitter.emit(cancelled_event)

            # Verify status update was called with CANCELLED
            mock_update.assert_called_once()
            call_kwargs = mock_update.call_args[1]
            assert call_kwargs["status"] == "CANCELLED"

        await emitter.close()

    @pytest.mark.asyncio
    async def test_emit_via_generic_emit(self):
        """Test emitting via generic emit method."""
        from app.services.execution.emitters import SubscriptionResultEmitter

        emitter = SubscriptionResultEmitter(
            task_id=1,
            subtask_id=1,
            execution_id=100,
        )

        # Emit chunk via generic emit
        chunk_event = ExecutionEvent.create(
            EventType.CHUNK,
            task_id=1,
            subtask_id=1,
            content="Test",
        )
        await emitter.emit(chunk_event)

        assert emitter._accumulated_content == "Test"

        await emitter.close()
