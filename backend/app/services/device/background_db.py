# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bound database work triggered by device heartbeats and registrations."""

import asyncio
from collections.abc import Callable
from typing import TypeVar

from prometheus_client import Counter

from app.core.async_utils import run_in_threadpool_with_cleanup

T = TypeVar("T")
_db_slots = asyncio.Semaphore(2)


async def run_device_background_db(operation: Callable[..., T], *args: object) -> T:
    """Hold the slot until the thread finishes, including on cancellation."""
    async with _db_slots:
        return await run_in_threadpool_with_cleanup(operation, *args)


_overload_total = Counter(
    "device_background_overload_total",
    "Device background jobs deferred because the worker is at capacity",
    ["operation"],
)


def record_device_background_overload(operation: str) -> None:
    _overload_total.labels(operation=operation).inc()
