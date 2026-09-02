# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded ownership for work detached from Web request lifetimes."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

TaskFactory = Callable[[], Awaitable[Any]]


class WebBackgroundTaskAdmissionClosed(RuntimeError):
    """Raised when detached Web work is submitted after shutdown starts."""


class WebBackgroundTaskCapacityError(RuntimeError):
    """Raised when synchronous admission cannot retain another task."""


class WebBackgroundTaskManager:
    """Own a finite set of detached tasks on the sole Uvicorn event loop.

    ``max_outstanding`` bounds both running tasks and tasks waiting for an
    execution slot. Async submitters backpressure at that bound; synchronous
    submitters fail before their factory is invoked. Accepted work is retained
    strongly and graceful shutdown waits for it instead of cancelling it.
    """

    def __init__(self, *, max_concurrency: int, max_outstanding: int) -> None:
        if max_concurrency <= 0:
            raise ValueError("max_concurrency must be positive")
        if max_outstanding < max_concurrency:
            raise ValueError("max_outstanding must be at least max_concurrency")
        self._max_concurrency = max_concurrency
        self._max_outstanding = max_outstanding
        self._loop: asyncio.AbstractEventLoop | None = None
        self._condition: asyncio.Condition | None = None
        self._drained: asyncio.Event | None = None
        self._accepting = False
        self._active = 0
        self._outstanding = 0
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def active_count(self) -> int:
        return self._active

    @property
    def outstanding_count(self) -> int:
        return self._outstanding

    @property
    def is_accepting(self) -> bool:
        return self._accepting

    def start(self) -> None:
        """Bind this manager to the current Web loop and open admission."""
        loop = asyncio.get_running_loop()
        if self._tasks or self._outstanding:
            raise RuntimeError("Cannot start with outstanding background tasks")
        if self._accepting:
            if self._loop is not loop:
                raise RuntimeError("Background task manager is bound to another loop")
            return
        self._loop = loop
        self._condition = asyncio.Condition()
        self._drained = asyncio.Event()
        self._drained.set()
        self._accepting = True
        self._active = 0
        self._outstanding = 0

    async def submit(self, factory: TaskFactory, *, name: str) -> asyncio.Task[None]:
        """Wait for finite admission, then detach one strongly owned task."""
        condition = self._require_current_loop()
        async with condition:
            await condition.wait_for(
                lambda: not self._accepting or self._outstanding < self._max_outstanding
            )
            if not self._accepting:
                raise WebBackgroundTaskAdmissionClosed(
                    f"Web background task admission is closed: {name}"
                )
            return self._admit(factory, name)

    def submit_nowait(
        self,
        factory: TaskFactory,
        *,
        name: str,
    ) -> asyncio.Task[None]:
        """Admit immediately or fail without constructing the awaitable."""
        self._require_current_loop()
        if not self._accepting:
            raise WebBackgroundTaskAdmissionClosed(
                f"Web background task admission is closed: {name}"
            )
        if self._outstanding >= self._max_outstanding:
            raise WebBackgroundTaskCapacityError(
                f"Web background task capacity is exhausted: {name}"
            )
        return self._admit(factory, name)

    def submit_threadsafe(self, factory: TaskFactory, *, name: str) -> None:
        """Backpressure a synchronous Web handler until loop admission succeeds."""
        loop = self._loop
        if loop is None or not loop.is_running():
            raise RuntimeError("Web background task manager is not running")
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is loop:
            raise RuntimeError(
                "submit_threadsafe cannot block the bound Web event loop"
            )
        submission: concurrent.futures.Future[asyncio.Task[None]] = (
            asyncio.run_coroutine_threadsafe(
                self.submit(factory, name=name),
                loop,
            )
        )
        submission.result()

    def submit_from_sync(self, factory: TaskFactory, *, name: str) -> None:
        """Admit work from sync code on either the Web loop or a route thread."""
        loop = self._loop
        if loop is None or not loop.is_running():
            raise RuntimeError("Web background task manager is not running")
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is loop:
            self.submit_nowait(factory, name=name)
            return
        self.submit_threadsafe(factory, name=name)

    async def stop_accepting(self) -> None:
        """Close admission while preserving every task already accepted."""
        condition = self._require_current_loop()
        async with condition:
            self._accepting = False
            condition.notify_all()

    async def drain(self) -> None:
        """Wait until all accepted tasks finish without cancelling them."""
        self._require_current_loop()
        if self._drained is None:
            raise RuntimeError("Web background task manager is not started")
        await self._drained.wait()

    async def shutdown(self) -> None:
        """Atomically close admission and join all accepted work."""
        await self.stop_accepting()
        await self.drain()
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
            self._tasks.clear()
        self._loop = None
        self._condition = None
        self._drained = None

    def _require_current_loop(self) -> asyncio.Condition:
        loop = asyncio.get_running_loop()
        if self._loop is None or self._condition is None:
            raise RuntimeError("Web background task manager is not started")
        if loop is not self._loop:
            raise RuntimeError("Web background tasks must use the bound Web loop")
        return self._condition

    def _admit(self, factory: TaskFactory, name: str) -> asyncio.Task[None]:
        if self._drained is None:
            raise RuntimeError("Web background task manager is not started")
        self._outstanding += 1
        self._drained.clear()
        try:
            task = asyncio.create_task(self._run(factory, name), name=name)
        except BaseException:
            self._outstanding -= 1
            if self._outstanding == 0:
                self._drained.set()
            raise
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    async def _run(self, factory: TaskFactory, name: str) -> None:
        condition = self._require_current_loop()
        active = False
        try:
            async with condition:
                await condition.wait_for(lambda: self._active < self._max_concurrency)
                self._active += 1
                active = True
            await factory()
        except asyncio.CancelledError:
            logger.info("Web background task cancelled externally: %s", name)
            raise
        except Exception:
            logger.exception("Web background task failed: %s", name)
        finally:
            async with condition:
                if active:
                    self._active -= 1
                self._outstanding -= 1
                if self._outstanding == 0:
                    if self._drained is None:
                        raise RuntimeError(
                            "Web background task manager lost its drain event"
                        )
                    self._drained.set()
                condition.notify_all()

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except BaseException:
            logger.exception("Web background task wrapper failed unexpectedly")


_background_concurrency = max(
    1,
    min(32, settings.WEB_HTTP_CONCURRENCY_RESERVE),
)
web_background_task_manager = WebBackgroundTaskManager(
    max_concurrency=_background_concurrency,
    max_outstanding=settings.WEB_MAX_CONCURRENCY,
)
