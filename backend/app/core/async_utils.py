# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Async utilities for safe cross-loop coroutine execution.

This module provides utilities for safely executing coroutines in different
event loop contexts, which is essential for:
- Background tasks that may run in different event loops
- WebSocket operations that need to use the main event loop
- HTTP clients (aiohttp) that bind to specific event loops

Key problems this module solves:
1. "Event loop is closed" - Session/Lock created in one loop, used in another
2. "Future attached to different loop" - Redis operations from wrong loop
3. "Timeout context manager should be used inside a task" - aiohttp timeout issue

Usage:
    # For fire-and-forget execution in main loop
    await run_in_main_loop(async_func, arg1, arg2, kwarg=value)

    # For background task execution with proper loop handling
    execute_async_safely(async_func, arg1, arg2)
"""

import asyncio
import concurrent.futures
import logging
import threading
from typing import Any, Callable, Coroutine, Optional, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Global reference to the main event loop (set during application startup)
_main_loop: Optional[asyncio.AbstractEventLoop] = None
_main_loop_lock = threading.Lock()


def set_main_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Set the main event loop reference.

    This should be called during application startup when the main
    event loop is running.

    Args:
        loop: The main event loop
    """
    global _main_loop
    with _main_loop_lock:
        _main_loop = loop
        logger.info("[ASYNC_LOOP] Main event loop set for async utilities")


def get_main_event_loop() -> Optional[asyncio.AbstractEventLoop]:
    """Get the main event loop reference.

    Returns:
        The main event loop or None if not set
    """
    with _main_loop_lock:
        return _main_loop


def is_main_loop_running() -> bool:
    """Check if the main event loop is running.

    Returns:
        True if main loop is set and running
    """
    with _main_loop_lock:
        loop = _main_loop
    return loop is not None and loop.is_running()


async def run_in_main_loop(
    func: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    **kwargs: Any,
) -> Optional[T]:
    """Execute an async function in the main event loop.

    This function handles the case where the current event loop is different
    from the main event loop (which can happen when event handlers run in
    background threads or different async contexts).

    If already in the main loop, executes directly.
    If in a different loop, schedules via run_coroutine_threadsafe (fire-and-forget).
    If no running loop, tries to schedule in main loop.

    Args:
        func: Async function to execute
        *args: Positional arguments for the function
        **kwargs: Keyword arguments for the function

    Returns:
        Result of the function if executed directly, None if scheduled
    """
    global _main_loop

    def _make_done_callback(
        context: str,
    ) -> Callable[["concurrent.futures.Future[Any]"], None]:
        """Create a done callback that logs exceptions."""

        def done_callback(future: "concurrent.futures.Future[Any]") -> None:
            try:
                future.result()
            except Exception:
                logger.warning(
                    "[ASYNC_LOOP] %s failed in main loop (%s): %s",
                    func.__name__,
                    context,
                    future.exception(),
                )

        return done_callback

    # Try to get current running loop
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop, try to schedule in main loop
        if _main_loop is not None and _main_loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(
                    func(*args, **kwargs), _main_loop
                )
                future.add_done_callback(_make_done_callback("no current loop"))
                logger.info(
                    "[ASYNC_LOOP] Scheduled %s in main loop (no current loop)",
                    func.__name__,
                )
            except Exception as e:
                logger.warning(
                    "[ASYNC_LOOP] Failed to schedule %s in main loop: %s",
                    func.__name__,
                    e,
                )
            return None
        else:
            logger.warning(
                "[ASYNC_LOOP] Cannot execute %s: no current loop and main loop not available",
                func.__name__,
            )
            return None

    # If we're already in the main loop or main loop not set, execute directly
    if _main_loop is None or current_loop is _main_loop:
        return await func(*args, **kwargs)

    # We're in a different loop, schedule in main loop (fire-and-forget)
    if _main_loop.is_running():
        try:
            future = asyncio.run_coroutine_threadsafe(func(*args, **kwargs), _main_loop)
            future.add_done_callback(_make_done_callback("cross-loop"))
            logger.info(
                "[ASYNC_LOOP] Scheduled %s in main loop from different loop",
                func.__name__,
            )
        except Exception as e:
            logger.warning(
                "[ASYNC_LOOP] Failed to schedule %s in main loop: %s",
                func.__name__,
                e,
            )
        return None
    else:
        # Main loop not running but we have a valid current loop.
        # This can happen during:
        # 1. Application startup before main loop is set
        # 2. Tests running in a different event loop
        # 3. Background threads with their own event loop
        #
        # For operations that don't depend on main loop resources (Redis, WebSocket),
        # it's safe to execute in the current loop. For operations that do depend on
        # main loop resources, they will fail with appropriate errors.
        logger.warning(
            "[ASYNC_LOOP] Main loop not running, executing %s in current loop "
            "(this may fail for operations requiring main loop resources)",
            func.__name__,
        )
        return await func(*args, **kwargs)


def execute_async_safely(
    func: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    timeout: Optional[float] = None,
    **kwargs: Any,
) -> Optional[T]:
    """Execute an async function safely from any context.

    This function creates a new event loop in a separate thread to execute
    the coroutine, avoiding event loop conflicts. This is useful for:
    - Background tasks in Celery workers
    - Synchronous code that needs to call async functions
    - Code that may run in different event loop contexts

    Timeout behavior:
    - If timeout is specified, the function waits up to `timeout` seconds for completion
    - On timeout, this function returns None immediately, but the background daemon
      thread continues running and may still complete the operation later
    - The result/error from the background thread is not captured after timeout
    - If you need the final result even after timeout, consider using
      schedule_async_task() with a callback, or increase the timeout value

    Args:
        func: Async function to execute
        *args: Positional arguments for the function
        timeout: Optional timeout in seconds (applies to both thread.join and asyncio.wait_for)
        **kwargs: Keyword arguments for the function

    Returns:
        Result of the function if completed within timeout, None on timeout or error
    """
    result: Optional[T] = None
    error: Optional[Exception] = None

    def run_in_new_loop() -> None:
        nonlocal result, error
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            coro = func(*args, **kwargs)
            if timeout is not None:
                result = loop.run_until_complete(
                    asyncio.wait_for(coro, timeout=timeout)
                )
            else:
                result = loop.run_until_complete(coro)
        except asyncio.TimeoutError:
            logger.warning(
                "[ASYNC_LOOP] Timeout executing %s (timeout=%s)",
                func.__name__,
                timeout,
            )
        except Exception as e:
            error = e
            logger.error(
                "[ASYNC_LOOP] Error executing %s: %s",
                func.__name__,
                e,
                exc_info=True,
            )
        finally:
            try:
                loop.close()
            except Exception:
                logger.info("[ASYNC_LOOP] Error closing event loop", exc_info=True)

    # Start execution in a daemon thread with its own event loop
    # Note: On timeout, the daemon thread continues running in the background
    # and may still write to result/error, but we return None immediately
    thread = threading.Thread(target=run_in_new_loop, daemon=True)
    thread.start()
    thread.join(timeout=timeout)

    if error:
        return None
    return result


def schedule_async_task(
    func: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    callback: Optional[Callable[[Optional[T], Optional[Exception]], None]] = None,
    **kwargs: Any,
) -> None:
    """Schedule an async task to run in the background.

    This function schedules the coroutine in the main event loop if available,
    otherwise creates a new thread with its own event loop.

    Args:
        func: Async function to execute
        *args: Positional arguments for the function
        callback: Optional callback(result, error) called when task completes
        **kwargs: Keyword arguments for the function
    """
    global _main_loop

    async def wrapper() -> None:
        """Wrapper that calls the callback with result/error."""
        result: Optional[T] = None
        error: Optional[Exception] = None
        try:
            result = await func(*args, **kwargs)
        except Exception as e:
            error = e
            logger.error(
                "[ASYNC_LOOP] Background task %s failed: %s",
                func.__name__,
                e,
                exc_info=True,
            )
        finally:
            if callback:
                try:
                    callback(result, error)
                except Exception:
                    logger.exception(
                        "[ASYNC_LOOP] Callback for %s failed",
                        func.__name__,
                    )

    def done_callback(future: "concurrent.futures.Future[Any]") -> None:
        """Log any exceptions from the scheduled task."""
        try:
            future.result()
        except Exception:
            logger.warning(
                "[ASYNC_LOOP] Scheduled background task %s failed: %s",
                func.__name__,
                future.exception(),
            )

    # Try to schedule in main loop first
    if _main_loop is not None and _main_loop.is_running():
        try:
            future = asyncio.run_coroutine_threadsafe(wrapper(), _main_loop)
            future.add_done_callback(done_callback)
            logger.info(
                "[ASYNC_LOOP] Scheduled background task %s in main loop",
                func.__name__,
            )
            return
        except Exception as e:
            logger.warning(
                "[ASYNC_LOOP] Failed to schedule %s in main loop: %s, using thread",
                func.__name__,
                e,
            )

    # Fallback: run in new thread with new event loop
    def run_in_new_loop() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(wrapper())
        finally:
            try:
                loop.close()
            except Exception:
                logger.info("[ASYNC_LOOP] Error closing event loop", exc_info=True)

    thread = threading.Thread(target=run_in_new_loop, daemon=True)
    thread.start()
    logger.info(
        "[ASYNC_LOOP] Started background task %s in new thread",
        func.__name__,
    )


class AsyncSessionManager:
    """Context manager for creating aiohttp ClientSession in the current loop.

    This manager ensures that aiohttp ClientSession is created in the current
    event loop context, avoiding "Event loop is closed" errors.

    Usage:
        async with AsyncSessionManager() as session:
            async with session.get(url) as resp:
                data = await resp.json()
    """

    def __init__(
        self,
        timeout: Optional[float] = None,
        **session_kwargs: Any,
    ) -> None:
        """Initialize the session manager.

        Args:
            timeout: Default timeout for requests
            **session_kwargs: Additional kwargs for ClientSession
        """
        self._timeout = timeout
        self._session_kwargs = session_kwargs
        self._session: Optional[Any] = None

    async def __aenter__(self) -> Any:
        """Create and return a new ClientSession."""
        import aiohttp

        timeout_config = None
        if self._timeout is not None:
            timeout_config = aiohttp.ClientTimeout(total=self._timeout)

        self._session = aiohttp.ClientSession(
            timeout=timeout_config,
            **self._session_kwargs,
        )
        return self._session

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Close the session."""
        if self._session is not None:
            await self._session.close()
            self._session = None
