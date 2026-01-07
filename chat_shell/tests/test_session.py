# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for session manager."""

import asyncio

import pytest


class TestSessionManager:
    """Tests for SessionManager."""

    @pytest.fixture
    def session_manager(self):
        """Create session manager instance."""
        from chat_shell.services.storage.session import SessionManager

        return SessionManager()

    @pytest.mark.asyncio
    async def test_register_and_cancel_stream(self, session_manager):
        """Test registering and cancelling a stream."""
        # Register stream
        cancel_event = await session_manager.register_stream(1)
        assert isinstance(cancel_event, asyncio.Event)
        assert not cancel_event.is_set()

        # Cancel stream
        success = await session_manager.cancel_stream(1)
        assert success is True
        assert cancel_event.is_set()

    @pytest.mark.asyncio
    async def test_is_cancelled_local_event(self, session_manager):
        """Test cancellation check with local event."""
        # Register stream
        cancel_event = await session_manager.register_stream(1)
        assert not session_manager.is_cancelled(1)

        # Set local event
        cancel_event.set()
        assert session_manager.is_cancelled(1)

    @pytest.mark.asyncio
    async def test_unregister_stream(self, session_manager):
        """Test unregistering a stream."""
        # Register stream
        await session_manager.register_stream(1)
        assert 1 in session_manager._local_events

        # Unregister stream
        await session_manager.unregister_stream(1)
        assert 1 not in session_manager._local_events

    @pytest.mark.asyncio
    async def test_noop_methods(self, session_manager):
        """Test no-op methods for compatibility."""
        # These should not raise exceptions
        result = await session_manager.save_streaming_content(1, "content")
        assert result is True

        content = await session_manager.get_streaming_content(1)
        assert content is None

        result = await session_manager.delete_streaming_content(1)
        assert result is True

        result = await session_manager.publish_streaming_chunk(1, "chunk")
        assert result is True

        result = await session_manager.publish_streaming_done(1, {"value": "test"})
        assert result is True


class TestStreamingCore:
    """Tests for StreamingCore."""

    @pytest.fixture
    def streaming_state(self):
        """Create streaming state."""
        from chat_shell.services.streaming.core import StreamingState

        return StreamingState(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="test_user",
        )

    def test_streaming_state_append_content(self, streaming_state):
        """Test appending content to streaming state."""
        streaming_state.append_content("Hello")
        assert streaming_state.full_response == "Hello"
        assert streaming_state.offset == 5

        streaming_state.append_content(" World")
        assert streaming_state.full_response == "Hello World"
        assert streaming_state.offset == 11

    def test_streaming_state_get_result(self, streaming_state):
        """Test getting current result."""
        streaming_state.append_content("Hello")

        result = streaming_state.get_current_result()
        assert result["value"] == "Hello"
        assert result["shell_type"] == "Chat"

    def test_streaming_state_thinking_steps(self, streaming_state):
        """Test adding thinking steps."""
        streaming_state.add_thinking_step({"title": "Step 1", "details": {}})
        streaming_state.add_thinking_step({"title": "Step 2", "details": {}})

        result = streaming_state.get_current_result(include_thinking=True)
        assert len(result["thinking"]) == 2
        assert result["thinking"][0]["title"] == "Step 1"
