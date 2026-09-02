# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Cancellation-safe bounded execution for synchronous work from async code."""

from __future__ import annotations

import asyncio
import contextvars
import os
import threading
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from typing import Any, Awaitable, Callable, Literal, TypeVar

T = TypeVar("T")


class BoundedExecutorOverloaded(RuntimeError):
    """Raised when both execution capacity and the finite waiter queue are full."""


@dataclass
class _CapacityWaiter:
    """One event-loop-local future waiting on process-local executor capacity."""

    loop: asyncio.AbstractEventLoop
    future: asyncio.Future[None]
    state: Literal["waiting", "granted", "consumed", "abandoned"] = "waiting"


class BoundedExecutor:
    """Run sync callables without an unbounded ThreadPoolExecutor queue."""

    def __init__(
        self,
        *,
        max_workers: int,
        max_in_flight: int,
        thread_name_prefix: str,
        max_waiters: int | None = None,
    ) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be positive")
        if max_in_flight < max_workers:
            raise ValueError("max_in_flight must be at least max_workers")
        if max_waiters is not None and max_waiters < 0:
            raise ValueError("max_waiters must not be negative")
        self._max_workers = max_workers
        self._max_in_flight = max_in_flight
        self._max_waiters = max_in_flight * 4 if max_waiters is None else max_waiters
        self._thread_name_prefix = thread_name_prefix
        self._owner_pid = os.getpid()
        self._executor = self._new_executor()
        self._capacity_lock = threading.Lock()
        self._available_capacity = max_in_flight
        self._capacity_waiters: deque[_CapacityWaiter] = deque()

    async def run(self, func: Callable[..., T], *args: Any) -> T:
        """Run one callable while bounding submitted and running work."""
        self._ensure_process_local()
        call = self._prepare_call(func, args)
        loop = asyncio.get_running_loop()

        await self._acquire_capacity(loop)
        try:
            future = loop.run_in_executor(self._executor, call)
        except BaseException:
            self._release_capacity()
            raise

        # Cancellation of the awaiting request must not release capacity while
        # its synchronous function continues running in a thread.
        def release_capacity(completed: asyncio.Future[T]) -> None:
            self._release_capacity()
            if not completed.cancelled():
                # A caller may already be cancelled while the thread later
                # fails. Retrieve the exception to avoid an orphaned-Future
                # warning; normal awaiters still receive the same exception.
                completed.exception()

        future.add_done_callback(release_capacity)
        return await asyncio.shield(future)

    def submit_nowait(
        self,
        func: Callable[..., T],
        *args: Any,
    ) -> Future[T] | None:
        """Submit bounded background work, or return ``None`` at capacity."""
        self._ensure_process_local()
        if not self._try_acquire_capacity():
            return None
        try:
            future = self._executor.submit(self._prepare_call(func, args))
        except BaseException:
            self._release_capacity()
            raise
        future.add_done_callback(lambda _: self._release_capacity())
        return future

    def _new_executor(self) -> ThreadPoolExecutor:
        return ThreadPoolExecutor(
            max_workers=self._max_workers,
            thread_name_prefix=self._thread_name_prefix,
        )

    def _ensure_process_local(self) -> None:
        """Replace thread-owned state inherited by a prefork child process."""
        current_pid = os.getpid()
        if self._owner_pid == current_pid:
            return

        # A fork copies locks and executor bookkeeping but not their owning
        # threads. Never acquire or shut down those inherited objects.
        self._executor = self._new_executor()
        self._capacity_lock = threading.Lock()
        self._available_capacity = self._max_in_flight
        self._capacity_waiters = deque()
        self._owner_pid = current_pid

    @staticmethod
    def _prepare_call(
        func: Callable[..., T],
        args: tuple[Any, ...],
    ) -> Callable[[], T]:
        context = contextvars.copy_context()
        return partial(context.run, func, *args)

    def _try_acquire_capacity(self) -> bool:
        with self._capacity_lock:
            if self._available_capacity <= 0:
                return False
            self._available_capacity -= 1
            return True

    async def _acquire_capacity(self, loop: asyncio.AbstractEventLoop) -> None:
        """Acquire one process-local slot without blocking the caller's loop."""
        waiter: _CapacityWaiter | None = None
        with self._capacity_lock:
            if self._available_capacity > 0:
                self._available_capacity -= 1
                return
            if len(self._capacity_waiters) >= self._max_waiters:
                raise BoundedExecutorOverloaded(
                    "Synchronous work admission capacity is exhausted"
                )
            waiter = _CapacityWaiter(loop=loop, future=loop.create_future())
            self._capacity_waiters.append(waiter)

        try:
            await asyncio.shield(waiter.future)
        except BaseException:
            release_grant = False
            with self._capacity_lock:
                if waiter.state == "waiting":
                    waiter.state = "abandoned"
                    self._capacity_waiters.remove(waiter)
                elif waiter.state == "granted":
                    waiter.state = "abandoned"
                    release_grant = True
            if release_grant:
                self._release_capacity()
            raise

        with self._capacity_lock:
            if waiter.state != "granted":
                raise RuntimeError("Executor capacity waiter completed without a grant")
            waiter.state = "consumed"

    def _release_capacity(self) -> None:
        """Return one slot, transferring it safely across event loops."""
        while True:
            waiter: _CapacityWaiter | None = None
            with self._capacity_lock:
                while self._capacity_waiters:
                    candidate = self._capacity_waiters.popleft()
                    if candidate.state != "waiting":
                        continue
                    if candidate.loop.is_closed():
                        candidate.state = "abandoned"
                        continue
                    candidate.state = "granted"
                    waiter = candidate
                    break

                if waiter is None:
                    if self._available_capacity >= self._max_in_flight:
                        raise RuntimeError(
                            "Executor capacity released more than acquired"
                        )
                    self._available_capacity += 1
                    return

            try:
                waiter.loop.call_soon_threadsafe(self._deliver_capacity, waiter)
                return
            except RuntimeError:
                with self._capacity_lock:
                    if waiter.state == "granted":
                        waiter.state = "abandoned"

    def _deliver_capacity(self, waiter: _CapacityWaiter) -> None:
        """Wake a waiter in its owning loop or pass an abandoned grant onward."""
        release_grant = False
        with self._capacity_lock:
            if waiter.state != "granted":
                return
            if waiter.future.done():
                waiter.state = "abandoned"
                release_grant = True
            else:
                waiter.future.set_result(None)
        if release_grant:
            self._release_capacity()


async def wait_without_abandoning(
    awaitable: Awaitable[T],
) -> tuple[asyncio.Future[T], asyncio.CancelledError | None]:
    """Wait until owned synchronous work stops before propagating cancellation."""
    task = asyncio.ensure_future(awaitable)
    cancellation: asyncio.CancelledError | None = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            if task.cancelled():
                break
            if cancellation is None:
                cancellation = exc
        except BaseException:
            break
    return task, cancellation


async def run_bounded_to_completion(
    executor: BoundedExecutor,
    func: Callable[..., T],
    *args: Any,
) -> T:
    """Run bounded work without abandoning it when its request is cancelled."""
    task, cancellation = await wait_without_abandoning(executor.run(func, *args))
    try:
        result = task.result()
    except BaseException as exc:
        if cancellation is not None:
            raise cancellation from exc
        raise
    if cancellation is not None:
        raise cancellation
    return result
