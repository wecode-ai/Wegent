# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Loop-local asynchronous rate admission without scheduler tasks."""

from __future__ import annotations

import asyncio
import weakref
from collections import deque
from dataclasses import dataclass, field


@dataclass
class _TokenWaiter:
    future: asyncio.Future[None]


@dataclass
class _TokenBucketState:
    lock: asyncio.Lock
    tokens: float
    updated_at: float
    waiters: deque[_TokenWaiter] = field(default_factory=deque)


class LoopLocalTokenBucket:
    """Apply one process policy independently on every event loop.

    Callers wait in FIFO order. Only the first waiter owns the refill timer, so
    load does not create one polling task per event. Cancellation removes the
    waiter before waking its successor and never consumes a token.
    """

    def __init__(self, *, rate_per_second: float, burst: int) -> None:
        if rate_per_second <= 0:
            raise ValueError("rate_per_second must be positive")
        if burst <= 0:
            raise ValueError("burst must be positive")
        self._rate_per_second = float(rate_per_second)
        self._burst = burst
        self._states: weakref.WeakKeyDictionary[
            asyncio.AbstractEventLoop,
            _TokenBucketState,
        ] = weakref.WeakKeyDictionary()

    @property
    def rate_per_second(self) -> float:
        return self._rate_per_second

    @property
    def burst(self) -> int:
        return self._burst

    async def acquire(self) -> None:
        """Wait for one token without dropping or executing work inline."""
        loop = asyncio.get_running_loop()
        state = self._states.get(loop)
        if state is None:
            state = _TokenBucketState(
                lock=asyncio.Lock(),
                tokens=float(self._burst),
                updated_at=loop.time(),
            )
            self._states[loop] = state

        waiter = _TokenWaiter(future=loop.create_future())
        async with state.lock:
            state.waiters.append(waiter)
            if len(state.waiters) == 1:
                waiter.future.set_result(None)

        try:
            await asyncio.shield(waiter.future)
            while True:
                async with state.lock:
                    if not state.waiters or state.waiters[0] is not waiter:
                        raise RuntimeError("Token bucket waiter lost FIFO ownership")
                    now = loop.time()
                    elapsed = max(0.0, now - state.updated_at)
                    state.tokens = min(
                        float(self._burst),
                        state.tokens + elapsed * self._rate_per_second,
                    )
                    state.updated_at = max(state.updated_at, now)
                    if state.tokens >= 1.0:
                        state.tokens -= 1.0
                        state.waiters.popleft()
                        self._wake_head(state)
                        return
                    wait_seconds = (1.0 - state.tokens) / self._rate_per_second
                await asyncio.sleep(wait_seconds)
        except BaseException:
            async with state.lock:
                was_head = bool(state.waiters and state.waiters[0] is waiter)
                try:
                    state.waiters.remove(waiter)
                except ValueError:
                    pass
                waiter.future.cancel()
                if was_head:
                    self._wake_head(state)
            raise

    @staticmethod
    def _wake_head(state: _TokenBucketState) -> None:
        if state.waiters and not state.waiters[0].future.done():
            state.waiters[0].future.set_result(None)


# One shared budget protects all event-oriented work on the sole Web loop.
# 4096 events/s preserves the documented 100 streams x 30 events/s target;
# a 256-event burst admits one immediate event per maximum Stream connection.
WEB_REALTIME_EVENTS_PER_SECOND = 4096.0
WEB_REALTIME_EVENT_BURST = 256
web_realtime_event_admission = LoopLocalTokenBucket(
    rate_per_second=WEB_REALTIME_EVENTS_PER_SECOND,
    burst=WEB_REALTIME_EVENT_BURST,
)
