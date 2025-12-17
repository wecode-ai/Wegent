# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Graceful shutdown management module.

This module provides service status management for load balancer health checks
during graceful shutdown. It uses local files to coordinate status across
multiple FastAPI workers.

Architecture:
- Each worker has its own status file: /tmp/wegent/workers/worker_<pid>.json
- Service status (healthy/draining) is used by load balancers to route traffic
- Active request tracking is NOT needed - Uvicorn handles this natively

Graceful Shutdown Flow:
1. K8s sends SIGTERM to the pod
2. preStop hook waits (e.g., 5 seconds) for load balancer to update
3. Application sets service status to DRAINING
4. Load balancer stops sending new requests (sees 503 from /api/service-status)
5. Uvicorn waits for existing requests to complete (--timeout-graceful-shutdown)
6. Application runs lifespan shutdown handlers
7. Process exits

Usage:
    # In lifespan startup
    await graceful_shutdown_manager.initialize()

    # In lifespan shutdown
    await graceful_shutdown_manager.set_service_status(ServiceStatus.DRAINING)
    await graceful_shutdown_manager.close()
"""

import asyncio
import json
import logging
import os
import time
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Directory for worker status files
WORKERS_DIR = Path(os.environ.get("WEGENT_WORKERS_DIR", "/tmp/wegent/workers"))

# Heartbeat interval in seconds
HEARTBEAT_INTERVAL = 30

# Stale threshold - if last_heartbeat is older than this, consider worker dead
STALE_THRESHOLD = 60

# Current worker's PID
WORKER_PID = os.getpid()


class ServiceStatus(str, Enum):
    """Service status enum for health check responses."""

    HEALTHY = "healthy"  # Returns 200 - accepting requests
    DRAINING = "draining"  # Returns 503 - preparing to shutdown


class GracefulShutdownManager:
    """
    Manager for graceful shutdown service status.

    This class uses local files to maintain worker status that can be
    queried by load balancers. It provides:

    1. Service status management (healthy/draining) - per-worker
    2. Periodic heartbeat to local file
    3. Status aggregation across all workers

    Note: Active request counting is NOT implemented here.
    Uvicorn handles request completion natively via --timeout-graceful-shutdown.
    """

    _instance: Optional["GracefulShutdownManager"] = None
    _initialized: bool = False
    _service_status: ServiceStatus = ServiceStatus.HEALTHY
    _worker_pid: int = WORKER_PID
    _worker_file: Path = WORKERS_DIR / f"worker_{WORKER_PID}.json"
    _heartbeat_task: Optional[asyncio.Task] = None
    _started_at: float = 0

    def __new__(cls):
        """Singleton pattern to ensure single manager instance per process."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @property
    def worker_pid(self) -> int:
        """Get the worker PID."""
        return self._worker_pid

    @property
    def worker_file(self) -> Path:
        """Get the worker file path."""
        return self._worker_file

    async def initialize(self) -> None:
        """
        Initialize the graceful shutdown manager.

        Creates the workers directory and worker file, starts heartbeat task.
        Should be called during application startup.
        """
        if self._initialized:
            return

        try:
            # Create workers directory if not exists
            WORKERS_DIR.mkdir(parents=True, exist_ok=True)

            # Initialize state
            self._service_status = ServiceStatus.HEALTHY
            self._started_at = time.time()
            self._initialized = True

            # Write initial worker file
            await self._write_worker_file()

            # Start heartbeat background task
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

            logger.info(
                f"Graceful shutdown manager initialized (pid={self._worker_pid}, "
                f"file={self._worker_file})"
            )

        except Exception as e:
            logger.warning(
                f"Failed to initialize graceful shutdown manager: {e}. "
                "Service status features will be limited."
            )
            self._initialized = False

    async def close(self) -> None:
        """
        Close the graceful shutdown manager.

        Stops heartbeat task and removes worker file.
        Should be called during application shutdown.
        """
        if not self._initialized:
            return

        # Cancel heartbeat task
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

        # Remove worker file
        try:
            if self._worker_file.exists():
                self._worker_file.unlink()
                logger.info(f"Removed worker file: {self._worker_file}")
        except Exception as e:
            logger.warning(f"Failed to remove worker file: {e}")

        self._initialized = False
        logger.info("Graceful shutdown manager closed")

    async def _write_worker_file(self) -> None:
        """Write current status to worker file."""
        if not self._initialized:
            return

        try:
            data = {
                "pid": self._worker_pid,
                "service_status": self._service_status.value,
                "last_heartbeat": time.time(),
                "started_at": self._started_at,
            }

            # Write atomically using temp file + rename
            temp_file = self._worker_file.with_suffix(".tmp")
            temp_file.write_text(json.dumps(data, indent=2))
            temp_file.rename(self._worker_file)

        except Exception as e:
            logger.error(f"Failed to write worker file: {e}")

    async def _heartbeat_loop(self) -> None:
        """Background task that writes heartbeat every HEARTBEAT_INTERVAL seconds."""
        while True:
            try:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                await self._write_worker_file()
                logger.debug(
                    f"Heartbeat written (pid={self._worker_pid}, "
                    f"status={self._service_status.value})"
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Heartbeat error: {e}")

    async def set_service_status(self, status: ServiceStatus) -> bool:
        """
        Set the service status for this worker.

        Args:
            status: The service status to set (HEALTHY or DRAINING)

        Returns:
            True if status was set successfully, False otherwise
        """
        self._service_status = status
        await self._write_worker_file()
        logger.info(f"Service status set to {status.value} (pid={self._worker_pid})")
        return True

    async def get_service_status(self) -> ServiceStatus:
        """
        Get the current service status for this worker.

        Returns:
            ServiceStatus.HEALTHY or ServiceStatus.DRAINING
        """
        return self._service_status

    @staticmethod
    def get_all_workers_status() -> Dict[str, Any]:
        """
        Scan workers directory and aggregate all worker statuses.

        Returns:
            Dictionary with aggregated status:
            {
                "workers": [...],
                "healthy_workers": int,
                "draining_workers": int,
                "stale_workers": int
            }
        """
        result: Dict[str, Any] = {
            "workers": [],
            "healthy_workers": 0,
            "draining_workers": 0,
            "stale_workers": 0,
        }

        if not WORKERS_DIR.exists():
            return result

        current_time = time.time()

        for worker_file in WORKERS_DIR.glob("worker_*.json"):
            try:
                data = json.loads(worker_file.read_text())
                last_heartbeat = data.get("last_heartbeat", 0)
                is_stale = (current_time - last_heartbeat) > STALE_THRESHOLD
                is_current = data.get("pid") == WORKER_PID

                worker_info = {
                    "pid": data.get("pid"),
                    "service_status": data.get("service_status", "unknown"),
                    "last_heartbeat": last_heartbeat,
                    "last_heartbeat_ago": round(current_time - last_heartbeat, 1),
                    "is_stale": is_stale,
                    "is_current": is_current,
                }

                result["workers"].append(worker_info)

                if is_stale:
                    result["stale_workers"] += 1
                    # Clean up stale worker file
                    try:
                        worker_file.unlink()
                        logger.info(f"Cleaned up stale worker file: {worker_file}")
                    except Exception as e:
                        logger.warning(f"Failed to clean up stale worker file: {e}")
                else:
                    # Only count non-stale workers
                    if data.get("service_status") == ServiceStatus.HEALTHY.value:
                        result["healthy_workers"] += 1
                    elif data.get("service_status") == ServiceStatus.DRAINING.value:
                        result["draining_workers"] += 1

            except json.JSONDecodeError as e:
                logger.warning(f"Invalid JSON in worker file {worker_file}: {e}")
            except Exception as e:
                logger.warning(f"Error reading worker file {worker_file}: {e}")

        return result


# Global singleton instance
graceful_shutdown_manager = GracefulShutdownManager()
