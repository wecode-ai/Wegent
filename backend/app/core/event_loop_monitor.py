# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Low-overhead watchdog for blocking work on the Web event loop."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

logger = logging.getLogger(__name__)

EVENT_LOOP_LAG_SAMPLE_INTERVAL_SECONDS = 1.0
EVENT_LOOP_LAG_WARNING_THRESHOLD_SECONDS = 0.25
EVENT_LOOP_LAG_WARNING_INTERVAL_SECONDS = 30.0


@dataclass(frozen=True)
class EventLoopLagSnapshot:
    """Current process-local evidence of Web event-loop scheduling delay."""

    last_seconds: float
    max_seconds: float
    threshold_breaches: int


class EventLoopLagMonitor:
    """Measure how late a periodic callback resumes on one asyncio loop."""

    def __init__(
        self,
        *,
        sample_interval_seconds: float = EVENT_LOOP_LAG_SAMPLE_INTERVAL_SECONDS,
        warning_threshold_seconds: float = EVENT_LOOP_LAG_WARNING_THRESHOLD_SECONDS,
        warning_interval_seconds: float = EVENT_LOOP_LAG_WARNING_INTERVAL_SECONDS,
    ) -> None:
        if sample_interval_seconds <= 0:
            raise ValueError("sample_interval_seconds must be positive")
        if warning_threshold_seconds <= 0:
            raise ValueError("warning_threshold_seconds must be positive")
        if warning_interval_seconds < 0:
            raise ValueError("warning_interval_seconds must not be negative")
        self._sample_interval_seconds = sample_interval_seconds
        self._warning_threshold_seconds = warning_threshold_seconds
        self._warning_interval_seconds = warning_interval_seconds
        self._task: asyncio.Task[None] | None = None
        self._last_lag_seconds = 0.0
        self._max_lag_seconds = 0.0
        self._threshold_breaches = 0
        self._last_warning_at = float("-inf")

    def start(self) -> None:
        """Start one monitor task on the currently running Web loop."""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(
            self._run(),
            name="wegent-web-event-loop-lag-monitor",
        )

    async def stop(self) -> None:
        """Stop the task without leaking it into event-loop shutdown."""
        task = self._task
        self._task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    @asynccontextmanager
    async def lifespan(self) -> AsyncIterator[None]:
        """Monitor exactly the period in which the Web process is serving."""
        self.start()
        try:
            yield
        finally:
            await self.stop()

    def snapshot(self) -> EventLoopLagSnapshot:
        """Return immutable process-local lag state for diagnostics."""
        return EventLoopLagSnapshot(
            last_seconds=self._last_lag_seconds,
            max_seconds=self._max_lag_seconds,
            threshold_breaches=self._threshold_breaches,
        )

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            expected_at = loop.time() + self._sample_interval_seconds
            await asyncio.sleep(self._sample_interval_seconds)
            observed_at = loop.time()
            lag_seconds = max(0.0, observed_at - expected_at)
            self._record(lag_seconds, observed_at)

    def _record(self, lag_seconds: float, observed_at: float) -> None:
        self._last_lag_seconds = lag_seconds
        self._max_lag_seconds = max(self._max_lag_seconds, lag_seconds)
        if lag_seconds < self._warning_threshold_seconds:
            return

        self._threshold_breaches += 1
        if observed_at - self._last_warning_at < self._warning_interval_seconds:
            return
        self._last_warning_at = observed_at
        logger.warning(
            "Uvicorn event loop scheduling lag detected: %.3fs "
            "(threshold=%.3fs, breaches=%d)",
            lag_seconds,
            self._warning_threshold_seconds,
            self._threshold_breaches,
        )


event_loop_lag_monitor = EventLoopLagMonitor()
