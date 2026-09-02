# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime watchdog coverage for accidental Uvicorn loop blocking."""

from __future__ import annotations

import asyncio
import time

import pytest

from app.core.event_loop_monitor import EventLoopLagMonitor


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"sample_interval_seconds": 0}, "sample_interval_seconds"),
        ({"warning_threshold_seconds": 0}, "warning_threshold_seconds"),
        ({"warning_interval_seconds": -1}, "warning_interval_seconds"),
    ],
)
def test_monitor_rejects_invalid_limits(kwargs: dict[str, float], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        EventLoopLagMonitor(**kwargs)


@pytest.mark.asyncio
async def test_monitor_detects_real_event_loop_stall() -> None:
    monitor = EventLoopLagMonitor(
        sample_interval_seconds=0.01,
        warning_threshold_seconds=0.02,
        warning_interval_seconds=0,
    )

    async with monitor.lifespan():
        await asyncio.sleep(0.02)
        time.sleep(0.07)
        await asyncio.sleep(0.03)

    snapshot = monitor.snapshot()
    assert snapshot.max_seconds >= 0.04
    assert snapshot.threshold_breaches >= 1


@pytest.mark.asyncio
async def test_monitor_start_is_idempotent_and_lifespan_stops_task() -> None:
    monitor = EventLoopLagMonitor(
        sample_interval_seconds=1,
        warning_threshold_seconds=1,
    )

    async with monitor.lifespan():
        first_task = monitor._task
        monitor.start()
        assert monitor._task is first_task

    assert monitor._task is None
