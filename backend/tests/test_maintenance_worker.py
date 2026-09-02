# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import signal
from unittest.mock import AsyncMock, Mock

import pytest

from app import maintenance_worker


@pytest.mark.asyncio
async def test_worker_owns_recovery_and_monitor_lifecycles(monkeypatch) -> None:
    handlers: dict[signal.Signals, object] = {}
    delayed_started = asyncio.Event()
    delayed_cancelled = asyncio.Event()

    def capture_handler(handled_signal, callback) -> None:
        handlers[handled_signal] = callback

    async def delayed_recovery() -> int:
        delayed_started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            delayed_cancelled.set()
            raise

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "add_signal_handler", capture_handler)
    monkeypatch.setattr(maintenance_worker, "setup_logging", Mock())
    initialize_event_services = Mock()
    monkeypatch.setattr(
        maintenance_worker,
        "_initialize_worker_event_services",
        initialize_event_services,
    )
    start_jobs = Mock()
    stop_jobs = AsyncMock()
    start_monitor = Mock()
    stop_monitor = AsyncMock()
    initial_recovery = AsyncMock(return_value=2)
    monkeypatch.setattr(maintenance_worker, "start_background_jobs", start_jobs)
    monkeypatch.setattr(maintenance_worker, "stop_background_jobs", stop_jobs)
    monkeypatch.setattr(maintenance_worker, "start_device_monitor", start_monitor)
    monkeypatch.setattr(
        maintenance_worker,
        "stop_device_monitor_async",
        stop_monitor,
    )
    monkeypatch.setattr(
        maintenance_worker,
        "recover_video_jobs",
        initial_recovery,
    )
    monkeypatch.setattr(
        maintenance_worker,
        "recover_video_jobs_after_stale_delay",
        delayed_recovery,
    )

    worker = asyncio.create_task(maintenance_worker.run_worker())
    await asyncio.wait_for(delayed_started.wait(), timeout=1)
    assert signal.SIGTERM in handlers
    handlers[signal.SIGTERM]()
    await asyncio.wait_for(worker, timeout=1)

    start_jobs.assert_called_once()
    initialize_event_services.assert_called_once_with()
    start_monitor.assert_called_once_with()
    initial_recovery.assert_awaited_once_with()
    assert delayed_cancelled.is_set()
    stop_monitor.assert_awaited_once_with()
    stop_jobs.assert_awaited_once()
