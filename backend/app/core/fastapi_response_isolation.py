# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bound Starlette's synchronous response work without a default threadpool."""

from __future__ import annotations

import hashlib
import inspect
import threading
from functools import lru_cache
from typing import Any, AsyncIterator, Callable, Iterable, Iterator, TypeVar, cast

import starlette
from starlette.background import BackgroundTask, BackgroundTasks
from starlette.concurrency import iterate_in_threadpool
from starlette.responses import Response, StreamingResponse

from app.core.bounded_executor import (
    BoundedExecutor,
    BoundedExecutorOverloaded,
    run_bounded_to_completion,
)

T = TypeVar("T")

SUPPORTED_STARLETTE_VERSION = "0.50.0"
_SYNC_RESPONSE_CAPACITY = 32
_SYNC_RESPONSE_CLEANUP_WORKERS = 4
_RESPONSE_STATE_ATTRIBUTE = "_wegent_response_execution"
_EXPECTED_SOURCE_HASHES: dict[str, tuple[Callable[..., Any], str]] = {
    "BackgroundTask.__init__": (
        BackgroundTask.__init__,
        "4659b6b6bf680579768fca181359f1a4fbf15889eb5378f8a4a180f1b3ae8746",
    ),
    "BackgroundTask.__call__": (
        BackgroundTask.__call__,
        "eefe65980ba39eb785d74ca27e9e00c77dd2837593c79c04f6fea61eecfcc7e1",
    ),
    "BackgroundTasks.add_task": (
        BackgroundTasks.add_task,
        "eed9124473aabc82d57b3dda8529bd310d4e389c90e58c9cf03268ac732338e3",
    ),
    "BackgroundTasks.__call__": (
        BackgroundTasks.__call__,
        "75a811addcf750022c485fe20c6de056fa0db72aa85ee90d88c443e2b5da3115",
    ),
    "Response.__call__": (
        Response.__call__,
        "9be5e18776d4de5807daab4d5352cb99271833eb175cccbdfa3ab8373010ad61",
    ),
    "StreamingResponse.__init__": (
        StreamingResponse.__init__,
        "8d8be20c1d2dedbdd7bab3f39a0066348ebb5e735fa7422253daa49dc264f707",
    ),
    "StreamingResponse.__call__": (
        StreamingResponse.__call__,
        "93fdd5077f6b5d12fef0b8998d2e3fa6d67d9782e202ffb52f6d6aa9828a8e12",
    ),
    "StreamingResponse.stream_response": (
        StreamingResponse.stream_response,
        "bfe07bbdc3c9c9a3426cf01b4b0f6ea98b11e97233cb13ead05f6c59735ab003",
    ),
    "iterate_in_threadpool": (
        iterate_in_threadpool,
        "bd2f57f863cd93964eedebc523ecca61494b9fe3a59592b8413baa2339357bda",
    ),
}


class _BoundedResponseLeases:
    """Fail before response start when no execution slot can be guaranteed."""

    def __init__(self, capacity: int, label: str) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._available = capacity
        self._label = label
        self._lock = threading.Lock()

    def acquire(self) -> "_ResponseLease":
        with self._lock:
            if self._available == 0:
                raise BoundedExecutorOverloaded(
                    f"Synchronous {self._label} capacity is exhausted"
                )
            self._available -= 1
        return _ResponseLease(self)

    def release(self) -> None:
        with self._lock:
            if self._available >= self._capacity:
                raise RuntimeError(f"Synchronous {self._label} lease released twice")
            self._available += 1


class _ResponseLease:
    def __init__(self, owner: _BoundedResponseLeases) -> None:
        self._owner = owner
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._owner.release()


_background_executor = BoundedExecutor(
    max_workers=_SYNC_RESPONSE_CAPACITY,
    max_in_flight=_SYNC_RESPONSE_CAPACITY,
    max_waiters=0,
    thread_name_prefix="wegent-fastapi-background",
)
_stream_iterator_executor = BoundedExecutor(
    max_workers=_SYNC_RESPONSE_CAPACITY,
    max_in_flight=_SYNC_RESPONSE_CAPACITY,
    max_waiters=0,
    thread_name_prefix="wegent-fastapi-stream-iterator",
)
_stream_cleanup_executor = BoundedExecutor(
    max_workers=_SYNC_RESPONSE_CLEANUP_WORKERS,
    max_in_flight=_SYNC_RESPONSE_CAPACITY,
    max_waiters=0,
    thread_name_prefix="wegent-fastapi-stream-cleanup",
)
_background_leases = _BoundedResponseLeases(
    _SYNC_RESPONSE_CAPACITY,
    "background task",
)
_stream_leases = _BoundedResponseLeases(
    _SYNC_RESPONSE_CAPACITY,
    "stream iterator",
)


@lru_cache(maxsize=1)
def assert_fastapi_response_isolation_contract() -> None:
    """Fail startup if Starlette's adapted response behavior changed."""
    if starlette.__version__ != SUPPORTED_STARLETTE_VERSION:
        raise RuntimeError(
            "FastAPI response isolation supports exactly Starlette "
            f"{SUPPORTED_STARLETTE_VERSION}; installed={starlette.__version__}"
        )
    for name, (callable_obj, expected_hash) in _EXPECTED_SOURCE_HASHES.items():
        source_hash = hashlib.sha256(
            inspect.getsource(callable_obj).encode("utf-8")
        ).hexdigest()
        if source_hash != expected_hash:
            raise RuntimeError(
                f"FastAPI response isolation contract changed for {name}: "
                f"expected={expected_hash}, installed={source_hash}"
            )
    probe = StreamingResponse(iter((b"probe",))).body_iterator
    if _extract_upstream_sync_iterable(probe) is None:
        raise RuntimeError(
            "Starlette sync stream wrapper no longer exposes its locked iterable"
        )


def _uses_framework_background_call(background: BackgroundTask) -> bool:
    return type(background).__call__ in {
        BackgroundTask.__call__,
        BackgroundTasks.__call__,
    }


def _has_sync_background(background: BackgroundTask) -> bool:
    if not _uses_framework_background_call(background):
        return False
    if isinstance(background, BackgroundTasks):
        return any(_has_sync_background(task) for task in background.tasks)
    return not background.is_async


async def _run_background_task(background: BackgroundTask) -> None:
    if not _uses_framework_background_call(background):
        await background()
        return
    if isinstance(background, BackgroundTasks):
        for task in background.tasks:
            await _run_background_task(task)
        return
    if background.is_async:
        await background.func(*background.args, **background.kwargs)
        return
    await run_bounded_to_completion(
        _background_executor,
        _invoke_background_sync,
        background.func,
        background.args,
        background.kwargs,
    )


def _invoke_background_sync(
    func: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> Any:
    return func(*args, **kwargs)


class _IsolatedBackground(BackgroundTask):
    def __init__(
        self,
        background: BackgroundTask,
        lease: _ResponseLease,
    ) -> None:
        self._background = background
        self._lease = lease

    async def __call__(self) -> None:
        try:
            await _run_background_task(self._background)
        finally:
            self._lease.release()

    def abort(self) -> None:
        self._lease.release()


class _EndOfIterator(Exception):
    pass


def _next_sync(iterator: Iterator[T]) -> T:
    try:
        return next(iterator)
    except StopIteration as exc:
        raise _EndOfIterator from exc


def _close_sync_iterables(
    iterator: Iterator[Any] | None,
    iterable: Iterable[Any],
) -> None:
    seen: set[int] = set()
    for value in (iterator, iterable):
        if value is None or id(value) in seen:
            continue
        seen.add(id(value))
        close = getattr(value, "close", None)
        if callable(close):
            close()


class _SyncStreamState:
    def __init__(self, iterable: Iterable[Any], lease: _ResponseLease) -> None:
        self.iterable = iterable
        self.iterator: Iterator[Any] | None = None
        self.lease = lease
        self._close_claimed = False
        self._close_lock = threading.Lock()

    def claim_close(self) -> bool:
        with self._close_lock:
            if self._close_claimed:
                return False
            self._close_claimed = True
            return True

    async def close(self) -> None:
        if not self.claim_close():
            return
        try:
            await run_bounded_to_completion(
                _stream_cleanup_executor,
                _close_sync_iterables,
                self.iterator,
                self.iterable,
            )
        finally:
            self.lease.release()


async def _iterate_sync_stream(state: _SyncStreamState) -> AsyncIterator[Any]:
    try:
        state.iterator = await run_bounded_to_completion(
            _stream_iterator_executor,
            iter,
            state.iterable,
        )
        while True:
            try:
                yield await run_bounded_to_completion(
                    _stream_iterator_executor,
                    _next_sync,
                    state.iterator,
                )
            except _EndOfIterator:
                break
    finally:
        await state.close()


def _extract_upstream_sync_iterable(body_iterator: Any) -> Iterable[Any] | None:
    if not inspect.isasyncgen(body_iterator):
        return None
    if body_iterator.ag_code is not iterate_in_threadpool.__code__:
        return None
    frame = body_iterator.ag_frame
    if frame is None:
        return None
    iterable = frame.f_locals.get("iterator")
    if iterable is None:
        return None
    return cast(Iterable[Any], iterable)


class ResponseExecution:
    """All reserved synchronous work attached to one response."""

    def __init__(
        self,
        stream: _SyncStreamState | None,
        background: _IsolatedBackground | None,
    ) -> None:
        self._stream = stream
        self._background = background

    async def finalize(self) -> None:
        try:
            if self._stream is not None:
                await self._stream.close()
        finally:
            if self._background is not None:
                self._background.abort()


def prepare_response_execution(response: Response) -> ResponseExecution:
    """Reserve and install bounded response work before any bytes are sent."""
    existing = getattr(response, _RESPONSE_STATE_ATTRIBUTE, None)
    if isinstance(existing, ResponseExecution):
        return existing

    original_background = response.background
    background_lease: _ResponseLease | None = None
    if isinstance(original_background, BackgroundTask) and _has_sync_background(
        original_background
    ):
        background_lease = _background_leases.acquire()

    streaming_response = response if isinstance(response, StreamingResponse) else None
    stream_state: _SyncStreamState | None = None
    try:
        if streaming_response is not None:
            iterable = _extract_upstream_sync_iterable(streaming_response.body_iterator)
            if iterable is not None:
                stream_state = _SyncStreamState(iterable, _stream_leases.acquire())
    except BaseException:
        if background_lease is not None:
            background_lease.release()
        raise

    isolated_background: _IsolatedBackground | None = None
    if background_lease is not None:
        assert isinstance(original_background, BackgroundTask)
        isolated_background = _IsolatedBackground(
            original_background,
            background_lease,
        )
        response.background = isolated_background
    if stream_state is not None:
        assert streaming_response is not None
        streaming_response.body_iterator = _iterate_sync_stream(stream_state)

    execution = ResponseExecution(stream_state, isolated_background)
    setattr(response, _RESPONSE_STATE_ATTRIBUTE, execution)
    return execution
