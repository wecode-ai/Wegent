# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Loop-local byte budgets for bounded asynchronous pipelines."""

from __future__ import annotations

import asyncio
import weakref
from dataclasses import dataclass


class ByteAdmissionTooLarge(ValueError):
    """Raised when one item can never fit inside a byte budget."""


@dataclass
class _ByteBudgetState:
    condition: asyncio.Condition
    used_bytes: int = 0


class ByteLease:
    """One idempotently releasable share of a loop-local byte budget."""

    def __init__(self, state: _ByteBudgetState, size: int) -> None:
        self._state = state
        self._size = size
        self._released = False

    async def release(self) -> None:
        """Return the reserved bytes exactly once."""
        if self._released:
            return
        async with self._state.condition:
            if self._released:
                return
            self._released = True
            self._state.used_bytes -= self._size
            self._state.condition.notify_all()


class LoopLocalByteAdmission:
    """Bound aggregate retained bytes independently on every event loop."""

    def __init__(self, max_bytes: int, *, label: str = "item") -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        if not label:
            raise ValueError("label must be non-empty")
        self._max_bytes = max_bytes
        self._label = label
        self._states: weakref.WeakKeyDictionary[
            asyncio.AbstractEventLoop,
            _ByteBudgetState,
        ] = weakref.WeakKeyDictionary()

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    async def acquire(self, size: int) -> ByteLease:
        """Wait until ``size`` bytes can be retained, then return their lease."""
        if size <= 0:
            raise ValueError("size must be positive")
        if size > self._max_bytes:
            raise ByteAdmissionTooLarge(
                f"{self._label} requires {size} bytes but budget is "
                f"{self._max_bytes} bytes"
            )
        loop = asyncio.get_running_loop()
        state = self._states.get(loop)
        if state is None:
            state = _ByteBudgetState(condition=asyncio.Condition())
            self._states[loop] = state
        async with state.condition:
            await state.condition.wait_for(
                lambda: state.used_bytes + size <= self._max_bytes
            )
            state.used_bytes += size
        return ByteLease(state, size)
