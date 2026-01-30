# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Log cleaner for local executor mode.

Implements automatic log cleanup with time and size based retention policies.
"""

import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Tuple

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("log_cleaner")


class LogCleaner:
    """
    Automatic log file cleanup manager.

    Features:
    - Time-based cleanup: delete logs older than retention days
    - Size-based cleanup: delete oldest logs when total exceeds max size
    """

    def __init__(
        self,
        log_dir: str = None,
        retention_days: int = None,
        max_total_size_mb: int = None,
    ):
        """
        Initialize the log cleaner.

        Args:
            log_dir: Log directory path. Defaults to config value.
            retention_days: Days to retain logs. Defaults to config value.
            max_total_size_mb: Max total log size in MB. Defaults to config value.
        """
        self.log_dir = log_dir or config.WEGENT_EXECUTOR_LOG_DIR
        self.retention_days = (
            retention_days or config.WEGENT_EXECUTOR_LOG_RETENTION_DAYS
        )
        self.max_total_size_mb = (
            max_total_size_mb or config.WEGENT_EXECUTOR_LOG_MAX_TOTAL_SIZE
        )

    def cleanup(self) -> Tuple[int, float]:
        """
        Perform log cleanup based on time and size policies.

        Returns:
            Tuple of (files_removed, size_freed_mb)
        """
        if not os.path.exists(self.log_dir):
            logger.debug(f"Log directory does not exist: {self.log_dir}")
            return 0, 0.0

        total_removed = 0
        total_freed_mb = 0.0

        # Phase 1: Remove files older than retention period
        removed, freed = self._cleanup_by_age()
        total_removed += removed
        total_freed_mb += freed

        # Phase 2: Remove oldest files if total size exceeds limit
        removed, freed = self._cleanup_by_size()
        total_removed += removed
        total_freed_mb += freed

        if total_removed > 0:
            logger.info(
                f"[LOG_CLEANUP] Removed {total_removed} files, freed {total_freed_mb:.2f}MB"
            )

        return total_removed, total_freed_mb

    def _cleanup_by_age(self) -> Tuple[int, float]:
        """
        Remove log files older than retention period.

        Returns:
            Tuple of (files_removed, size_freed_mb)
        """
        cutoff_time = datetime.now() - timedelta(days=self.retention_days)
        cutoff_timestamp = cutoff_time.timestamp()

        removed = 0
        freed_bytes = 0

        for file_path in self._get_log_files():
            try:
                stat = os.stat(file_path)
                if stat.st_mtime < cutoff_timestamp:
                    size = stat.st_size
                    os.remove(file_path)
                    removed += 1
                    freed_bytes += size
                    logger.debug(f"Removed old log file: {file_path}")
            except (OSError, IOError) as e:
                logger.warning(f"Failed to remove log file {file_path}: {e}")

        return removed, freed_bytes / (1024 * 1024)

    def _cleanup_by_size(self) -> Tuple[int, float]:
        """
        Remove oldest log files until total size is under limit.

        Returns:
            Tuple of (files_removed, size_freed_mb)
        """
        max_bytes = self.max_total_size_mb * 1024 * 1024
        files_with_stats = []

        # Collect file info
        for file_path in self._get_log_files():
            try:
                stat = os.stat(file_path)
                files_with_stats.append((file_path, stat.st_mtime, stat.st_size))
            except (OSError, IOError):
                continue

        # Calculate total size
        total_size = sum(size for _, _, size in files_with_stats)

        if total_size <= max_bytes:
            return 0, 0.0

        # Sort by modification time (oldest first)
        files_with_stats.sort(key=lambda x: x[1])

        removed = 0
        freed_bytes = 0

        for file_path, _, size in files_with_stats:
            if total_size <= max_bytes:
                break

            try:
                os.remove(file_path)
                removed += 1
                freed_bytes += size
                total_size -= size
                logger.debug(f"Removed log file (size limit): {file_path}")
            except (OSError, IOError) as e:
                logger.warning(f"Failed to remove log file {file_path}: {e}")

        return removed, freed_bytes / (1024 * 1024)

    def _get_log_files(self) -> List[str]:
        """
        Get all log files in the log directory.

        Returns:
            List of log file paths
        """
        log_files = []
        log_path = Path(self.log_dir)

        if not log_path.exists():
            return log_files

        # Match common log file extensions
        log_extensions = {".log", ".log.1", ".log.2", ".log.3", ".log.4", ".log.5"}

        for item in log_path.iterdir():
            if item.is_file():
                # Check if file has log extension or matches rotation pattern
                if item.suffix in log_extensions or any(
                    item.name.endswith(ext) for ext in log_extensions
                ):
                    log_files.append(str(item))
                elif item.suffix == "" and "log" in item.name.lower():
                    # Also catch files like "executor.log.1"
                    log_files.append(str(item))

        return log_files

    def get_log_stats(self) -> dict:
        """
        Get statistics about current log files.

        Returns:
            Dict with file_count, total_size_mb, oldest_file_age_days
        """
        files = self._get_log_files()
        total_size = 0
        oldest_mtime = time.time()

        for file_path in files:
            try:
                stat = os.stat(file_path)
                total_size += stat.st_size
                if stat.st_mtime < oldest_mtime:
                    oldest_mtime = stat.st_mtime
            except (OSError, IOError):
                continue

        age_days = (time.time() - oldest_mtime) / (24 * 3600) if files else 0

        return {
            "file_count": len(files),
            "total_size_mb": total_size / (1024 * 1024),
            "oldest_file_age_days": age_days,
        }
