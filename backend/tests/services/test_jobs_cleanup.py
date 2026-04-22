# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cleanup worker coordination."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest

from app.services.jobs import cleanup_worker


@asynccontextmanager
async def _lock_context(acquired: bool):
    yield acquired


@pytest.mark.unit
async def test_cleanup_worker_skips_when_lock_is_held():
    """Test cleanup worker does not run cleanup without acquiring the lock."""
    import asyncio

    stop_event = asyncio.Event()

    # Will run one iteration then stop
    async def _run_worker():
        # Start the worker
        task = asyncio.create_task(cleanup_worker(stop_event))
        # Let it run one iteration
        await asyncio.sleep(0.1)
        stop_event.set()
        await task

    with (
        patch(
            "app.services.jobs.distributed_lock.acquire_watchdog_context_async",
            return_value=_lock_context(False),
            create=True,
        ),
        patch(
            "app.services.jobs.job_service.cleanup_stale_executors",
            new_callable=AsyncMock,
        ) as cleanup_mock,
        patch("app.services.jobs.AsyncSessionLocal") as session_local,
        patch("app.services.jobs.settings") as mock_settings,
    ):
        mock_settings.TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS = 0.01
        await _run_worker()

    cleanup_mock.assert_not_called()
    session_local.assert_not_called()
