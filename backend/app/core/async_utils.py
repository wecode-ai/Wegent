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
    await run_in_main_loop(async_func, arg1, arg2, kwarg=value)
    execute_async_safely(async_func, arg1, arg2)
"""

import asyncio
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
) -> T:
    """Execute and join an async function on the configured main event loop.

    Cross-loop callers retain request ownership by awaiting the concurrent
    future. A missing or stopped main loop is an explicit lifecycle error; the
    coroutine is never retried on an arbitrary loop.

    Args:
        func: Async function to execute
        *args: Positional arguments for the function
        **kwargs: Keyword arguments for the function

    Returns:
        Result of the function
    """
    with _main_loop_lock:
        main_loop = _main_loop

    if main_loop is None:
        raise RuntimeError("Main event loop is not configured")
    return await run_in_event_loop(main_loop, func, *args, **kwargs)


async def run_in_event_loop(
    event_loop: asyncio.AbstractEventLoop,
    func: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Execute and join a coroutine on one explicitly owned event loop."""
    current_loop = asyncio.get_running_loop()
    if current_loop is event_loop:
        return await func(*args, **kwargs)
    if not event_loop.is_running():
        raise RuntimeError("Target event loop is not running")

    future = asyncio.run_coroutine_threadsafe(
        func(*args, **kwargs),
        event_loop,
    )
    return await asyncio.wrap_future(future)


def execute_async_safely(
    func: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    timeout: Optional[float] = None,
    **kwargs: Any,
) -> Optional[T]:
    """Run and join an async operation from synchronous worker code.

    The caller must not be an event-loop thread. A private loop is used in the
    current worker thread, and timeout cancellation is completed before return;
    no daemon thread or detached continuation survives the call.

    Args:
        func: Async function to execute
        *args: Positional arguments for the function
        timeout: Optional timeout in seconds (applies to both thread.join and asyncio.wait_for)
        **kwargs: Keyword arguments for the function

    Returns:
        Result of the function if completed within timeout, None on timeout or error
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError("execute_async_safely cannot run on an event-loop thread")

    async def run() -> T:
        operation = func(*args, **kwargs)
        if timeout is None:
            return await operation
        return await asyncio.wait_for(operation, timeout=timeout)

    try:
        return asyncio.run(run())
    except asyncio.TimeoutError:
        logger.warning(
            "[ASYNC_LOOP] Timeout executing %s (timeout=%s)",
            func.__name__,
            timeout,
        )
    except Exception as error:
        logger.error(
            "[ASYNC_LOOP] Error executing %s: %s",
            func.__name__,
            error,
            exc_info=True,
        )
        return None
    return None


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
