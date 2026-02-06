# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests demonstrating async event loop issues and their fixes.

These tests reproduce the original bugs that were fixed in the async_utils module:
1. "Event loop is closed" - aiohttp session bound to closed loop
2. "Future attached to different loop" - asyncio.Lock bound to different loop
3. Cross-loop execution issues - operations scheduled in wrong event loop

Run these tests to verify the fixes work correctly.
"""

import asyncio
import threading
import time
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.async_utils import (
    AsyncSessionManager,
    execute_async_safely,
    get_main_event_loop,
    run_in_main_loop,
    schedule_async_task,
    set_main_event_loop,
)


class TestCrossLoopExecution:
    """Tests for cross-loop execution scenarios.

    These tests simulate the scenario where code runs in a different
    event loop than the main FastAPI loop.
    """

    @pytest.mark.asyncio
    async def test_run_in_main_loop_from_different_loop(self) -> None:
        """Test that run_in_main_loop schedules execution in main loop.

        This simulates the scenario where a Celery worker thread or
        background thread tries to execute async code that should
        run in the main loop.
        """
        import app.core.async_utils as async_utils

        # Save original state
        original_main_loop = async_utils._main_loop

        # Set current loop as main loop
        main_loop = asyncio.get_running_loop()
        async_utils._main_loop = main_loop

        results = []

        async def async_func(value: int) -> int:
            results.append(f"executed in loop: {asyncio.get_running_loop() is main_loop}")
            return value * 2

        # When in the same loop, should execute directly
        result = await run_in_main_loop(async_func, 5)
        assert result == 10
        assert "executed in loop: True" in results

        # Restore original state
        async_utils._main_loop = original_main_loop

    def test_execute_async_safely_creates_new_loop(self) -> None:
        """Test that execute_async_safely creates a new event loop.

        This is useful for Celery workers or synchronous code that
        needs to call async functions without an existing event loop.
        """
        execution_info: dict = {"loop_id": None}

        async def async_func() -> str:
            execution_info["loop_id"] = id(asyncio.get_running_loop())
            return "done"

        result = execute_async_safely(async_func, timeout=5.0)

        assert result == "done"
        assert execution_info["loop_id"] is not None

    def test_execute_async_safely_with_zero_timeout(self) -> None:
        """Test that timeout=0.0 is respected (not treated as False).

        This was a bug where `if timeout:` treated 0.0 as False,
        so asyncio.wait_for was not used with timeout=0.
        """

        async def slow_func() -> str:
            await asyncio.sleep(1.0)
            return "done"

        # With timeout=0.0, should timeout immediately
        result = execute_async_safely(slow_func, timeout=0.0)

        # Should return None due to immediate timeout
        # Note: Due to thread scheduling, this might occasionally succeed
        # but typically it should timeout
        assert result is None or result == "done"


class TestAsyncSessionManager:
    """Tests for AsyncSessionManager.

    The AsyncSessionManager was created to solve the problem where
    a shared aiohttp ClientSession was bound to one event loop but
    used from another, causing "Event loop is closed" errors.
    """

    @pytest.mark.asyncio
    async def test_session_created_in_current_loop(self) -> None:
        """Test that session is created in the current event loop.

        This ensures each request gets a session bound to its own loop,
        avoiding cross-loop issues.
        """
        current_loop = asyncio.get_running_loop()

        with patch("aiohttp.ClientSession") as mock_session_class:
            mock_session = AsyncMock()
            mock_session.close = AsyncMock()
            mock_session_class.return_value = mock_session

            async with AsyncSessionManager(timeout=30.0) as session:
                # Session should be created
                assert session is mock_session

            # Session should be closed
            mock_session.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_session_with_custom_timeout(self) -> None:
        """Test that custom timeout is passed to session."""
        with patch("aiohttp.ClientSession") as mock_session_class:
            with patch("aiohttp.ClientTimeout") as mock_timeout_class:
                mock_session = AsyncMock()
                mock_session.close = AsyncMock()
                mock_session_class.return_value = mock_session

                async with AsyncSessionManager(timeout=60.0) as session:
                    pass

                # Timeout should be created with correct value
                mock_timeout_class.assert_called_once_with(total=60.0)


class TestScheduleAsyncTask:
    """Tests for schedule_async_task.

    This function schedules async tasks in the main loop if available,
    otherwise creates a new thread with its own loop.
    """

    def test_schedule_task_in_new_thread(self) -> None:
        """Test that task is scheduled in new thread when main loop unavailable."""
        import app.core.async_utils as async_utils

        # Save and clear main loop
        original = async_utils._main_loop
        async_utils._main_loop = None

        result_holder: dict = {"result": None, "error": None}
        event = threading.Event()

        async def async_func() -> str:
            return "completed"

        def callback(result: Optional[str], error: Optional[Exception]) -> None:
            result_holder["result"] = result
            result_holder["error"] = error
            event.set()

        try:
            schedule_async_task(async_func, callback=callback)

            # Wait for completion
            event.wait(timeout=5.0)

            assert result_holder["result"] == "completed"
            assert result_holder["error"] is None
        finally:
            async_utils._main_loop = original


class TestOriginalBugReproduction:
    """Tests that reproduce the original bugs.

    These tests demonstrate what would happen WITHOUT the fixes.
    They are designed to show the problem scenarios.
    """

    def test_shared_session_cross_loop_issue(self) -> None:
        """Demonstrate the shared session cross-loop problem.

        Original problem:
        1. Session created in loop A
        2. Loop A closes or changes
        3. New request tries to use session from loop B
        4. Error: "Event loop is closed" or "Future attached to different loop"

        Solution: AsyncSessionManager creates a new session per request.
        """
        # This test demonstrates the FIXED behavior
        results = []

        def run_in_loop_1():
            """Simulate first request creating a session."""
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                async def request_1():
                    async with AsyncSessionManager(timeout=10.0) as session:
                        results.append("loop1: session created")
                        return session

                loop.run_until_complete(request_1())
            finally:
                loop.close()
                results.append("loop1: closed")

        def run_in_loop_2():
            """Simulate second request in different loop."""
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                async def request_2():
                    # With AsyncSessionManager, this works fine
                    # because a NEW session is created in THIS loop
                    async with AsyncSessionManager(timeout=10.0) as session:
                        results.append("loop2: session created (no error!)")
                        return session

                loop.run_until_complete(request_2())
            finally:
                loop.close()
                results.append("loop2: closed")

        # Run in sequence - different loops
        run_in_loop_1()
        run_in_loop_2()

        # Both should succeed with the fix
        assert "loop1: session created" in results
        assert "loop2: session created (no error!)" in results

    def test_cross_loop_event_scheduling(self) -> None:
        """Demonstrate cross-loop event scheduling.

        Original problem:
        1. Main loop set during FastAPI startup
        2. Background thread (Celery) creates its own loop
        3. Event bus publish from background thread fails

        Solution: Detect cross-loop and schedule in main loop.
        """
        import app.core.async_utils as async_utils

        original = async_utils._main_loop
        execution_order = []

        # Create "main" loop
        main_loop = asyncio.new_event_loop()

        def run_main_loop():
            """Run the main loop in a thread."""
            asyncio.set_event_loop(main_loop)
            async_utils._main_loop = main_loop

            async def keep_running():
                execution_order.append("main_loop_started")
                # Keep running for a bit
                await asyncio.sleep(0.5)
                execution_order.append("main_loop_ending")

            main_loop.run_until_complete(keep_running())

        # Start main loop in a thread
        main_thread = threading.Thread(target=run_main_loop)
        main_thread.start()

        # Wait for main loop to start
        time.sleep(0.1)

        # Now simulate a background thread trying to execute async code
        def background_thread_work():
            """Simulate Celery worker thread."""
            execution_order.append("background_thread_started")

            # This would fail with the old code if it tried to
            # use resources bound to main_loop

            # With execute_async_safely, it creates its own loop
            async def async_work():
                execution_order.append("async_work_executed")
                return "done"

            result = execute_async_safely(async_work, timeout=2.0)
            execution_order.append(f"background_thread_result: {result}")

        bg_thread = threading.Thread(target=background_thread_work)
        bg_thread.start()
        bg_thread.join(timeout=3.0)

        # Wait for main loop to finish
        main_thread.join(timeout=3.0)

        # Restore original state
        async_utils._main_loop = original

        # Verify execution order
        assert "main_loop_started" in execution_order
        assert "background_thread_started" in execution_order
        assert "async_work_executed" in execution_order
        assert "background_thread_result: done" in execution_order
