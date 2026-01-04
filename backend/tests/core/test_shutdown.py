# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for graceful shutdown functionality.

These tests verify that the shutdown manager correctly:
1. Tracks shutdown state
2. Registers and unregisters streams
3. Waits for active streams to complete
4. Cancels streams on timeout
"""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.core.shutdown import ShutdownManager


class TestShutdownManager:
    """Tests for ShutdownManager class."""

    @pytest.fixture
    def shutdown_manager(self):
        """Create a fresh ShutdownManager for each test."""
        manager = ShutdownManager()
        yield manager
        # Reset state after test
        manager.reset()

    @pytest.mark.asyncio
    async def test_initial_state(self, shutdown_manager):
        """Test that shutdown manager starts in non-shutdown state."""
        assert shutdown_manager.is_shutting_down is False
        assert shutdown_manager.get_active_stream_count() == 0
        assert shutdown_manager.shutdown_duration == 0.0

    @pytest.mark.asyncio
    async def test_initiate_shutdown(self, shutdown_manager):
        """Test initiating shutdown."""
        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.initiate_shutdown()

            assert shutdown_manager.is_shutting_down is True
            assert shutdown_manager.shutdown_duration > 0

    @pytest.mark.asyncio
    async def test_initiate_shutdown_idempotent(self, shutdown_manager):
        """Test that initiating shutdown multiple times is safe."""
        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.initiate_shutdown()
            first_duration = shutdown_manager.shutdown_duration

            await asyncio.sleep(0.1)
            await shutdown_manager.initiate_shutdown()

            # Duration should continue from first initiation
            assert shutdown_manager.shutdown_duration > first_duration

    @pytest.mark.asyncio
    async def test_register_stream_success(self, shutdown_manager):
        """Test registering a stream when not shutting down."""
        result = await shutdown_manager.register_stream(123)

        assert result is True
        assert shutdown_manager.get_active_stream_count() == 1
        assert 123 in shutdown_manager.get_active_streams()

    @pytest.mark.asyncio
    async def test_register_stream_during_shutdown(self, shutdown_manager):
        """Test that registering a stream during shutdown still succeeds.

        During graceful shutdown, we still accept new streams from existing
        WebSocket connections. New WebSocket connections are rejected at the
        connection level (on_connect), but requests from already connected
        clients should be allowed to complete gracefully.
        """
        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.initiate_shutdown()
            result = await shutdown_manager.register_stream(123)

            # Streams are still accepted during shutdown for graceful handling
            assert result is True
            assert shutdown_manager.get_active_stream_count() == 1

    @pytest.mark.asyncio
    async def test_unregister_stream(self, shutdown_manager):
        """Test unregistering a stream."""
        await shutdown_manager.register_stream(123)
        assert shutdown_manager.get_active_stream_count() == 1

        await shutdown_manager.unregister_stream(123)
        assert shutdown_manager.get_active_stream_count() == 0

    @pytest.mark.asyncio
    async def test_unregister_nonexistent_stream(self, shutdown_manager):
        """Test that unregistering a nonexistent stream is safe."""
        await shutdown_manager.unregister_stream(999)
        assert shutdown_manager.get_active_stream_count() == 0

    @pytest.mark.asyncio
    async def test_wait_for_streams_no_streams(self, shutdown_manager):
        """Test waiting when there are no active streams."""
        result = await shutdown_manager.wait_for_streams(timeout=1.0)
        assert result is True

    @pytest.mark.asyncio
    async def test_wait_for_streams_completes(self, shutdown_manager):
        """Test waiting for streams that complete in time."""
        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.register_stream(123)
            await shutdown_manager.initiate_shutdown()

            # Simulate stream completing
            async def complete_stream():
                await asyncio.sleep(0.1)
                await shutdown_manager.unregister_stream(123)

            asyncio.create_task(complete_stream())

            result = await shutdown_manager.wait_for_streams(timeout=1.0)
            assert result is True

    @pytest.mark.asyncio
    async def test_wait_for_streams_timeout(self, shutdown_manager):
        """Test waiting for streams that don't complete in time."""
        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.register_stream(123)
            await shutdown_manager.initiate_shutdown()

            # Don't complete the stream
            result = await shutdown_manager.wait_for_streams(timeout=0.1)
            assert result is False
            assert shutdown_manager.get_active_stream_count() == 1

    @pytest.mark.asyncio
    async def test_cancel_all_streams(self, shutdown_manager):
        """Test cancelling all active streams."""
        # Import the session_manager instance and patch its cancel_stream method
        from app.services.chat.storage import session_manager

        with patch.object(
            session_manager, "cancel_stream", new_callable=AsyncMock
        ) as mock_cancel:
            mock_cancel.return_value = True

            await shutdown_manager.register_stream(123)
            await shutdown_manager.register_stream(456)

            cancelled = await shutdown_manager.cancel_all_streams()

            assert cancelled == 2
            assert mock_cancel.call_count == 2

    @pytest.mark.asyncio
    async def test_multiple_streams(self, shutdown_manager):
        """Test managing multiple streams."""
        await shutdown_manager.register_stream(1)
        await shutdown_manager.register_stream(2)
        await shutdown_manager.register_stream(3)

        assert shutdown_manager.get_active_stream_count() == 3

        await shutdown_manager.unregister_stream(2)
        assert shutdown_manager.get_active_stream_count() == 2
        assert 2 not in shutdown_manager.get_active_streams()

    @pytest.mark.asyncio
    async def test_reset(self, shutdown_manager):
        """Test resetting shutdown manager state."""
        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.register_stream(123)
            await shutdown_manager.initiate_shutdown()

            shutdown_manager.reset()

            assert shutdown_manager.is_shutting_down is False
            assert shutdown_manager.get_active_stream_count() == 0
            assert shutdown_manager.shutdown_duration == 0.0


class TestShutdownIntegration:
    """Integration tests for shutdown functionality."""

    @pytest.mark.asyncio
    async def test_shutdown_flow(self):
        """Test the complete shutdown flow.

        During graceful shutdown, new streams from existing connections are
        still accepted. New WebSocket connections are rejected at the
        connection level (on_connect).
        """
        manager = ShutdownManager()

        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            # Register some streams
            await manager.register_stream(1)
            await manager.register_stream(2)

            # Initiate shutdown
            await manager.initiate_shutdown()
            assert manager.is_shutting_down is True

            # New streams are still accepted during shutdown (from existing connections)
            result = await manager.register_stream(3)
            assert result is True

            # Complete all streams
            await manager.unregister_stream(1)
            await manager.unregister_stream(2)
            await manager.unregister_stream(3)

            # Wait should complete immediately
            result = await manager.wait_for_streams(timeout=1.0)
            assert result is True

            manager.reset()
