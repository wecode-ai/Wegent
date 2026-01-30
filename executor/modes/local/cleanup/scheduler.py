# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cleanup scheduler for local executor mode.

Schedules periodic cleanup tasks for logs and workspaces.
"""

import asyncio
from typing import Callable, List, Optional

from executor.modes.local.cleanup.log_cleaner import LogCleaner
from executor.modes.local.cleanup.workspace_cleaner import WorkspaceCleaner
from shared.logger import setup_logger

logger = setup_logger("cleanup_scheduler")


class CleanupScheduler:
    """
    Schedules and manages cleanup tasks.

    Features:
    - Run log cleanup on startup and periodically (default: every hour)
    - Run orphan workspace detection on startup (after backend sync)
    - Async-friendly scheduling
    """

    def __init__(
        self,
        log_cleanup_interval: int = 3600,  # 1 hour
        workspace_sync_callback: Optional[Callable[[], List[str]]] = None,
    ):
        """
        Initialize the cleanup scheduler.

        Args:
            log_cleanup_interval: Interval for log cleanup in seconds
            workspace_sync_callback: Async callback to get valid task IDs from backend
        """
        self.log_cleanup_interval = log_cleanup_interval
        self.workspace_sync_callback = workspace_sync_callback

        self.log_cleaner = LogCleaner()
        self.workspace_cleaner = WorkspaceCleaner()

        self._running = False
        self._tasks: List[asyncio.Task] = []

    async def start(self) -> None:
        """Start the cleanup scheduler."""
        if self._running:
            logger.warning("Cleanup scheduler already running")
            return

        self._running = True
        logger.info("Starting cleanup scheduler")

        # Run initial cleanup
        await self._run_initial_cleanup()

        # Start periodic log cleanup task
        self._tasks.append(asyncio.create_task(self._log_cleanup_loop()))

        logger.info(
            f"Cleanup scheduler started: log_cleanup_interval={self.log_cleanup_interval}s"
        )

    async def stop(self) -> None:
        """Stop the cleanup scheduler."""
        if not self._running:
            return

        self._running = False

        # Cancel all tasks
        for task in self._tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        self._tasks.clear()
        logger.info("Cleanup scheduler stopped")

    async def _run_initial_cleanup(self) -> None:
        """Run cleanup tasks on startup."""
        logger.info("Running initial cleanup")

        # Log cleanup
        try:
            removed, freed = self.log_cleaner.cleanup()
            if removed > 0:
                logger.info(
                    f"Initial log cleanup: removed {removed} files, freed {freed:.2f}MB"
                )
        except Exception as e:
            logger.error(f"Initial log cleanup failed: {e}")

        # Workspace sync (if callback provided)
        if self.workspace_sync_callback:
            try:
                valid_task_ids = await self.workspace_sync_callback()
                if valid_task_ids is not None:
                    cleaned = self.workspace_cleaner.cleanup_orphans(valid_task_ids)
                    if cleaned > 0:
                        logger.info(
                            f"Initial workspace cleanup: removed {cleaned} orphan workspaces"
                        )
            except Exception as e:
                logger.error(f"Initial workspace cleanup failed: {e}")

    async def _log_cleanup_loop(self) -> None:
        """Periodic log cleanup loop."""
        while self._running:
            try:
                await asyncio.sleep(self.log_cleanup_interval)

                if not self._running:
                    break

                self.log_cleaner.cleanup()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Log cleanup error: {e}")

    async def run_workspace_sync(self, valid_task_ids: List[str]) -> int:
        """
        Manually trigger workspace sync.

        Args:
            valid_task_ids: List of valid task IDs from backend

        Returns:
            Number of workspaces removed
        """
        return self.workspace_cleaner.sync_workspaces(valid_task_ids)

    def delete_workspace(self, task_id: str) -> bool:
        """
        Delete a specific workspace.

        Args:
            task_id: Task ID whose workspace should be deleted

        Returns:
            True if deleted successfully
        """
        return self.workspace_cleaner.delete_workspace(task_id)
