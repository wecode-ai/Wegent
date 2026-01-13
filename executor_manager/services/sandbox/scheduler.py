# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox scheduler for periodic background tasks.

This module handles scheduled tasks for sandbox management:
- Heartbeat checking: Detect dead executor containers
- Garbage collection: Clean up expired sandboxes

Uses APScheduler for task scheduling.
"""

import os
import time
from typing import TYPE_CHECKING, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor_manager.services.sandbox.manager import SandboxManager

logger = setup_logger(__name__)

# Configuration from environment variables
GC_INTERVAL = int(os.getenv("GC_INTERVAL", "3600"))  # 1 hour default
HEARTBEAT_CHECK_INTERVAL = int(os.getenv("HEARTBEAT_CHECK_INTERVAL", "5"))  # seconds


class SandboxScheduler:
    """Scheduler for sandbox background tasks.

    Manages two periodic jobs:
    - Heartbeat check: Runs every HEARTBEAT_CHECK_INTERVAL (default 10s)
    - Sandbox GC: Runs every GC_INTERVAL (default 1 hour)
    """

    def __init__(self, sandbox_manager: "SandboxManager"):
        """Initialize the scheduler.

        Args:
            sandbox_manager: SandboxManager instance for task execution
        """
        self._sandbox_manager = sandbox_manager
        self._scheduler: Optional[AsyncIOScheduler] = None

    async def start(self) -> None:
        """Start the scheduler with configured jobs."""
        if self._scheduler is not None and self._scheduler.running:
            logger.warning("[SandboxScheduler] Scheduler is already running")
            return

        self._scheduler = AsyncIOScheduler(
            job_defaults={
                "coalesce": True,  # Combine missed executions into one
                "max_instances": 1,  # Only one instance of each job at a time
                "misfire_grace_time": 30,  # Allow 30s grace period for missed jobs
            }
        )

        # Add heartbeat check job
        self._scheduler.add_job(
            self._sandbox_manager._check_heartbeats,
            IntervalTrigger(seconds=HEARTBEAT_CHECK_INTERVAL),
            id="heartbeat_check",
            name="Heartbeat Check",
            replace_existing=True,
        )

        # Add sandbox GC job
        self._scheduler.add_job(
            self._sandbox_manager._collect_expired_sandboxes,
            IntervalTrigger(seconds=GC_INTERVAL),
            id="sandbox_gc",
            name="Sandbox GC",
            replace_existing=True,
        )

        self._scheduler.start()
        logger.info(
            f"[SandboxScheduler] Started with jobs: "
            f"heartbeat_check (every {HEARTBEAT_CHECK_INTERVAL}s), "
            f"sandbox_gc (every {GC_INTERVAL}s)"
        )

    async def stop(self) -> None:
        """Stop the scheduler."""
        if self._scheduler is not None and self._scheduler.running:
            self._scheduler.shutdown(wait=False)
            self._scheduler = None
            logger.info("[SandboxScheduler] Stopped")

    @property
    def is_running(self) -> bool:
        """Check if scheduler is running."""
        return self._scheduler is not None and self._scheduler.running
