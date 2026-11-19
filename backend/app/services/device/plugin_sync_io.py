"""Keep database admission separate from device response waits."""

import asyncio
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")
_limits: ContextVar[tuple[asyncio.Semaphore, asyncio.Semaphore] | None] = ContextVar(
    "plugin_sync_limits", default=None
)


@contextmanager
def limit_plugin_sync_io(
    database: asyncio.Semaphore, device: asyncio.Semaphore
) -> Iterator[None]:
    token = _limits.set((database, device))
    try:
        yield
    finally:
        _limits.reset(token)


async def run_plugin_sync_db(
    operation: Callable[P, T], *args: P.args, **kwargs: P.kwargs
) -> T:
    limits = _limits.get()
    if limits is None:
        return await asyncio.to_thread(operation, *args, **kwargs)
    slots = limits[0]
    await slots.acquire()
    worker = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))

    def release(completed: asyncio.Task[T]) -> None:
        slots.release()
        if not completed.cancelled():
            completed.exception()

    # Cancelling the waiter does not stop work already executing in the thread.
    worker.add_done_callback(release)
    return await asyncio.shield(worker)


async def await_plugin_sync_device(
    operation: Callable[P, Awaitable[T]], *args: P.args, **kwargs: P.kwargs
) -> T:
    limits = _limits.get()
    if limits is None:
        return await operation(*args, **kwargs)
    async with limits[1]:
        return await operation(*args, **kwargs)
