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
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException, Response

from app.api.endpoints import health
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
        from app.core.local_shutdown import is_local_shutdown

        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.initiate_shutdown()

            assert shutdown_manager.is_shutting_down is True
            assert is_local_shutdown() is True
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
    async def test_hybrid_shutdown_marker_tracks_python_lifecycle(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        marker = tmp_path / "marker" / "shutting-down"
        marker.parent.mkdir()
        marker.touch()
        monkeypatch.setenv("WEGENT_HYBRID_SHUTDOWN_FILE", str(marker))
        manager = ShutdownManager()
        monkeypatch.setattr(health, "shutdown_manager", manager)
        assert not marker.exists()
        marker.parent.rmdir()

        try:
            with patch("app.core.cache.cache_manager") as mock_cache:
                mock_cache.set = AsyncMock(return_value=True)
                # A missing parent makes the first marker write fail.
                with pytest.raises(HTTPException) as error:
                    await health.initiate_shutdown()
                assert error.value.status_code == 503
                assert manager.is_shutting_down
                assert not marker.exists()

                response = Response()
                result = await health.wait_for_shutdown(response)
                assert response.status_code == 503
                assert result["status"] == "completed"
                assert result["marker_synced"] is False

                marker.parent.mkdir()
                result = await health.initiate_shutdown()
                assert result["status"] == "already_shutting_down"
                assert marker.is_file()
                mock_cache.set.assert_awaited_once()
        finally:
            manager.reset()
        assert not marker.exists()

    @pytest.mark.asyncio
    async def test_reset_retries_when_hybrid_marker_cannot_be_removed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        marker = tmp_path / "shutting-down"
        monkeypatch.setenv("WEGENT_HYBRID_SHUTDOWN_FILE", str(marker))
        manager = ShutdownManager()
        monkeypatch.setattr(health, "shutdown_manager", manager)

        try:
            with patch("app.core.cache.cache_manager") as mock_cache:
                mock_cache.set = AsyncMock(return_value=True)
                assert (await manager.initiate_shutdown()).started
            marker.unlink()
            marker.mkdir()

            with pytest.raises(HTTPException) as error:
                await health.reset_shutdown()
            assert error.value.status_code == 503
            assert manager.is_shutting_down
            assert marker.exists()

            marker.rmdir()
            marker.touch()
            assert (await health.reset_shutdown())["status"] == "reset_complete"
            assert not manager.is_shutting_down
            assert not marker.exists()
        finally:
            if marker.is_dir():
                marker.rmdir()
            manager.reset()

    @pytest.mark.asyncio
    async def test_repeated_shutdown_proceeds_while_redis_publish_is_pending(
        self, shutdown_manager: ShutdownManager
    ) -> None:
        publishing = asyncio.Event()
        finish_publish = asyncio.Event()

        async def publish(*args, **kwargs) -> bool:
            publishing.set()
            await finish_publish.wait()
            return True

        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(side_effect=publish)
            first = asyncio.create_task(shutdown_manager.initiate_shutdown())
            try:
                await asyncio.wait_for(publishing.wait(), timeout=5)
                repeated = await asyncio.wait_for(
                    shutdown_manager.initiate_shutdown(), timeout=5
                )
                assert not repeated.started
                assert repeated.marker_synced
                mock_cache.set.assert_awaited_once()
            finally:
                finish_publish.set()
                await first

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
        from app.core.local_shutdown import is_local_shutdown

        with patch("app.core.cache.cache_manager") as mock_cache:
            mock_cache.set = AsyncMock(return_value=True)

            await shutdown_manager.register_stream(123)
            await shutdown_manager.initiate_shutdown()

            shutdown_manager.reset()

            assert shutdown_manager.is_shutting_down is False
            assert shutdown_manager.get_active_stream_count() == 0
            assert shutdown_manager.shutdown_duration == 0.0
            assert is_local_shutdown() is False


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
