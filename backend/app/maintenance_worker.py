# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process entry point for Backend maintenance loops."""

from __future__ import annotations

import asyncio
import logging
import signal
from types import SimpleNamespace

from app.core.logging import setup_logging
from app.services.device_monitor import (
    start_device_monitor,
    stop_device_monitor_async,
)
from app.services.execution.agents.video.recovery import (
    recover_video_jobs,
    recover_video_jobs_after_stale_delay,
)
from app.services.jobs import start_background_jobs, stop_background_jobs

logger = logging.getLogger(__name__)


def _initialize_worker_event_services() -> None:
    """Initialize cross-process emitters and completion handlers once."""
    from app.core.socketio import get_sio
    from app.services.chat.webpage_ws_chat_emitter import init_ws_emitter
    from app.services.execution.completion_handlers import (
        initialize_execution_completion_handlers,
    )

    init_ws_emitter(get_sio())
    initialize_execution_completion_handlers()


async def run_worker() -> None:
    """Run background recovery and maintenance outside Uvicorn."""
    setup_logging()
    _initialize_worker_event_services()
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_event.set)

    app = SimpleNamespace(state=SimpleNamespace())
    start_background_jobs(app)
    start_device_monitor()
    video_recovery_task: asyncio.Task[int] | None = None
    try:
        recovered_count = await recover_video_jobs()
        logger.info("Recovered %d in-progress video job(s)", recovered_count)
        video_recovery_task = asyncio.create_task(
            recover_video_jobs_after_stale_delay()
        )
        await stop_event.wait()
    finally:
        if video_recovery_task is not None:
            video_recovery_task.cancel()
            await asyncio.gather(video_recovery_task, return_exceptions=True)
        await stop_device_monitor_async()
        await stop_background_jobs(app)


def main() -> None:
    """Run maintenance worker lifecycle."""
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
