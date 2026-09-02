# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for async utilities module."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.async_utils import (
    AsyncSessionManager,
    execute_async_safely,
    get_main_event_loop,
    is_main_loop_running,
    run_in_main_loop,
    set_main_event_loop,
)


class TestSetMainEventLoop:
    """Tests for set_main_event_loop function."""

    def test_set_main_event_loop(self) -> None:
        """Test setting the main event loop."""
        import app.core.async_utils as async_utils

        # Save original state
        original = async_utils._main_loop
        loop = asyncio.new_event_loop()
        try:
            set_main_event_loop(loop)
            assert get_main_event_loop() is loop
        finally:
            # Restore original state
            async_utils._main_loop = original
            loop.close()

    def test_get_main_event_loop_returns_none_initially(self) -> None:
        """Test that get_main_event_loop returns None if not set."""
        # Reset global state
        import app.core.async_utils as async_utils

        original = async_utils._main_loop
        async_utils._main_loop = None
        try:
            assert get_main_event_loop() is None
        finally:
            async_utils._main_loop = original


class TestIsMainLoopRunning:
    """Tests for is_main_loop_running function."""

    def test_returns_false_when_no_loop_set(self) -> None:
        """Test that is_main_loop_running returns False when no loop is set."""
        import app.core.async_utils as async_utils

        original = async_utils._main_loop
        async_utils._main_loop = None
        try:
            assert is_main_loop_running() is False
        finally:
            async_utils._main_loop = original

    def test_returns_false_when_loop_not_running(self) -> None:
        """Test that is_main_loop_running returns False when loop is not running."""
        import app.core.async_utils as async_utils

        original = async_utils._main_loop
        loop = asyncio.new_event_loop()
        try:
            set_main_event_loop(loop)
            assert is_main_loop_running() is False
        finally:
            async_utils._main_loop = original
            loop.close()


class TestRunInMainLoop:
    """Tests for run_in_main_loop function."""

    @pytest.mark.asyncio
    async def test_executes_directly_when_in_main_loop(self) -> None:
        """Test that function executes directly when already in main loop."""
        import app.core.async_utils as async_utils

        # Set current loop as main loop
        current_loop = asyncio.get_running_loop()
        async_utils._main_loop = current_loop

        async def async_func(x: int) -> int:
            return x * 2

        result = await run_in_main_loop(async_func, 5)
        assert result == 10

    @pytest.mark.asyncio
    async def test_fails_when_no_main_loop_is_configured(self) -> None:
        """A missing owner must never fall back to the caller's loop."""
        import app.core.async_utils as async_utils

        async_utils._main_loop = None

        async def async_func(x: int) -> int:
            return x * 2

        with pytest.raises(RuntimeError, match="not configured"):
            await run_in_main_loop(async_func, 5)

    @pytest.mark.asyncio
    async def test_handles_kwargs(self) -> None:
        """Test that function handles keyword arguments correctly."""
        import app.core.async_utils as async_utils

        current_loop = asyncio.get_running_loop()
        async_utils._main_loop = current_loop

        async def async_func(x: int, multiplier: int = 1) -> int:
            return x * multiplier

        result = await run_in_main_loop(async_func, 5, multiplier=3)
        assert result == 15

    @pytest.mark.asyncio
    async def test_cross_loop_execution_is_joined(self) -> None:
        """The caller observes both completion and the main-loop result."""
        import app.core.async_utils as async_utils

        original = async_utils._main_loop
        main_loop = asyncio.get_running_loop()
        async_utils._main_loop = main_loop
        executed = asyncio.Event()

        async def async_func(value: int) -> int:
            assert asyncio.get_running_loop() is main_loop
            executed.set()
            return value * 2

        def run_from_worker_thread() -> int | None:
            return asyncio.run(run_in_main_loop(async_func, 5))

        try:
            result = await asyncio.to_thread(run_from_worker_thread)
        finally:
            async_utils._main_loop = original

        assert result == 10
        assert executed.is_set()


class TestExecuteAsyncSafely:
    """Tests for execute_async_safely function."""

    def test_executes_async_function_successfully(self) -> None:
        """Test that async function executes successfully."""

        async def async_func(x: int) -> int:
            return x * 2

        result = execute_async_safely(async_func, 5, timeout=5.0)
        assert result == 10

    def test_returns_none_on_timeout(self) -> None:
        """Test that function returns None on timeout."""

        async def slow_func() -> str:
            await asyncio.sleep(10)
            return "done"

        result = execute_async_safely(slow_func, timeout=0.1)
        assert result is None

    def test_returns_none_on_error(self) -> None:
        """Test that function returns None on error."""

        async def failing_func() -> str:
            raise ValueError("test error")

        result = execute_async_safely(failing_func, timeout=5.0)
        assert result is None


class TestAsyncSessionManager:
    """Tests for AsyncSessionManager class."""

    @pytest.mark.asyncio
    async def test_creates_session_with_timeout(self) -> None:
        """Test that session is created with correct timeout."""
        with patch("aiohttp.ClientSession") as mock_session_class:
            mock_session = AsyncMock()
            mock_session.close = AsyncMock()
            mock_session_class.return_value = mock_session

            async with AsyncSessionManager(timeout=30.0) as session:
                assert session is mock_session

            mock_session.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_creates_session_without_timeout(self) -> None:
        """Test that session is created without timeout when not specified."""
        with patch("aiohttp.ClientSession") as mock_session_class:
            mock_session = AsyncMock()
            mock_session.close = AsyncMock()
            mock_session_class.return_value = mock_session

            async with AsyncSessionManager() as session:
                assert session is mock_session

            # Verify session was created with timeout=None
            call_args = mock_session_class.call_args
            assert call_args.kwargs.get("timeout") is None

    @pytest.mark.asyncio
    async def test_closes_session_on_exit(self) -> None:
        """Test that session is closed on context manager exit."""
        with patch("aiohttp.ClientSession") as mock_session_class:
            mock_session = AsyncMock()
            mock_session.close = AsyncMock()
            mock_session_class.return_value = mock_session

            async with AsyncSessionManager():
                pass

            mock_session.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_closes_session_on_exception(self) -> None:
        """Test that session is closed even when exception occurs."""
        with patch("aiohttp.ClientSession") as mock_session_class:
            mock_session = AsyncMock()
            mock_session.close = AsyncMock()
            mock_session_class.return_value = mock_session

            with pytest.raises(ValueError):
                async with AsyncSessionManager():
                    raise ValueError("test error")

            mock_session.close.assert_called_once()
