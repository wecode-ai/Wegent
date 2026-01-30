# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
System statistics collector for local executor mode.

Collects system resource information for heartbeat reporting.
"""

import os
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import psutil

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("system_stats")


class SystemStatsCollector:
    """
    Collects system resource statistics.

    Features:
    - Memory usage (process and system)
    - Disk usage (for executor home directory)
    - CPU usage
    - Workspace and log directory sizes
    - Executor uptime tracking
    """

    def __init__(self):
        """Initialize the system stats collector."""
        self._start_time = datetime.now()
        self._process = psutil.Process()

        # Cache directory sizes (updated periodically)
        self._workspace_size_cache: Optional[float] = None
        self._workspace_count_cache: Optional[int] = None
        self._log_size_cache: Optional[float] = None
        self._last_cache_update: float = 0
        self._cache_ttl = 300  # 5 minutes

        # Task stats
        self._completed_today = 0
        self._last_reset_date = datetime.now().date()

    def collect(self) -> Dict:
        """
        Collect all system statistics.

        Returns:
            Dict with system stats
        """
        # Update caches if needed
        self._update_caches_if_needed()

        # Memory stats
        mem_info = self._process.memory_info()
        system_mem = psutil.virtual_memory()

        # Disk stats for executor home directory
        disk_path = config.WEGENT_EXECUTOR_HOME
        try:
            disk_usage = psutil.disk_usage(disk_path)
            disk_stats = {
                "disk_used_gb": disk_usage.used / (1024**3),
                "disk_total_gb": disk_usage.total / (1024**3),
                "disk_free_gb": disk_usage.free / (1024**3),
                "disk_percent": disk_usage.percent,
            }
        except (OSError, IOError):
            # Fallback to root partition
            disk_usage = psutil.disk_usage("/")
            disk_stats = {
                "disk_used_gb": disk_usage.used / (1024**3),
                "disk_total_gb": disk_usage.total / (1024**3),
                "disk_free_gb": disk_usage.free / (1024**3),
                "disk_percent": disk_usage.percent,
            }

        # CPU usage (average over 0.1 second)
        cpu_percent = self._process.cpu_percent(interval=0.1)

        # Uptime
        uptime = (datetime.now() - self._start_time).total_seconds()

        return {
            "memory_used_mb": mem_info.rss / (1024 * 1024),
            "memory_total_mb": system_mem.total / (1024 * 1024),
            "memory_percent": (mem_info.rss / system_mem.total) * 100,
            **disk_stats,
            "workspace_size_mb": self._workspace_size_cache or 0,
            "workspace_count": self._workspace_count_cache or 0,
            "log_size_mb": self._log_size_cache or 0,
            "cpu_percent": cpu_percent,
            "uptime_seconds": int(uptime),
        }

    def collect_task_stats(self, running_tasks: int, queued_tasks: int) -> Dict:
        """
        Collect task-related statistics.

        Args:
            running_tasks: Number of currently running tasks
            queued_tasks: Number of tasks in queue

        Returns:
            Dict with task stats
        """
        # Reset daily counter if day changed
        today = datetime.now().date()
        if today != self._last_reset_date:
            self._completed_today = 0
            self._last_reset_date = today

        return {
            "running_tasks": running_tasks,
            "queued_tasks": queued_tasks,
            "completed_today": self._completed_today,
        }

    def increment_completed_tasks(self) -> None:
        """Increment the completed tasks counter for today."""
        # Reset if day changed
        today = datetime.now().date()
        if today != self._last_reset_date:
            self._completed_today = 0
            self._last_reset_date = today

        self._completed_today += 1

    def _update_caches_if_needed(self) -> None:
        """Update directory size caches if TTL expired."""
        now = time.time()
        if now - self._last_cache_update < self._cache_ttl:
            return

        self._last_cache_update = now

        # Update workspace cache
        workspace_root = config.LOCAL_WORKSPACE_ROOT
        if os.path.exists(workspace_root):
            size, count = self._get_directory_stats(workspace_root)
            self._workspace_size_cache = size
            self._workspace_count_cache = count

        # Update log cache
        log_dir = config.WEGENT_EXECUTOR_LOG_DIR
        if os.path.exists(log_dir):
            size, _ = self._get_directory_stats(log_dir)
            self._log_size_cache = size

    def _get_directory_stats(self, path: str) -> tuple:
        """
        Get directory size and item count.

        Args:
            path: Directory path

        Returns:
            Tuple of (size_mb, item_count)
        """
        total_size = 0
        item_count = 0

        try:
            root_path = Path(path)
            if root_path.is_dir():
                # Count direct children as items
                item_count = sum(1 for _ in root_path.iterdir())

                # Calculate total size
                for dirpath, _, filenames in os.walk(path):
                    for filename in filenames:
                        filepath = os.path.join(dirpath, filename)
                        try:
                            total_size += os.path.getsize(filepath)
                        except (OSError, IOError):
                            continue
        except (OSError, IOError):
            pass

        return total_size / (1024 * 1024), item_count

    def get_uptime_seconds(self) -> int:
        """Get executor uptime in seconds."""
        return int((datetime.now() - self._start_time).total_seconds())
