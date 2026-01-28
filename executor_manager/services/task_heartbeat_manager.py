# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Running Task Tracker for executor OOM detection.

This module tracks running regular (online) tasks in Redis to enable
heartbeat-based crash detection. When an executor container dies unexpectedly
(OOM, etc.), the heartbeat stops and executor_manager can detect this via
heartbeat timeout, then mark the task as failed.

Key difference from Sandbox:
- Sandbox tasks are long-lived and managed via SandboxManager
- Regular tasks are transient and callback-based

This tracker stores minimal metadata needed to:
1. Identify which tasks are currently running
2. Find the corresponding backend API to call for failure notification
"""

import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import redis

from executor_manager.common.redis_factory import RedisClientFactory
from shared.logger import setup_logger

logger = setup_logger(__name__)

# Redis key patterns
RUNNING_TASKS_ZSET = "running_tasks:heartbeat"  # ZSet: score=start_time, member=task_id
RUNNING_TASK_META_KEY = "running_task:meta:{task_id}"  # Hash: task metadata

# Default task timeout (seconds) - if no heartbeat received within this time,
# the task is considered dead. This should be >= HEARTBEAT_TIMEOUT
DEFAULT_TASK_TIMEOUT = int(os.getenv("TASK_HEARTBEAT_TIMEOUT", "60"))


class RunningTaskTracker:
    """Track running tasks for heartbeat-based crash detection.

    This class manages a Redis Sorted Set to track all running regular tasks.
    When combined with the HeartbeatManager, it enables detection of executor
    crashes (OOM, etc.) for all task types.

    Usage:
    1. When a task starts, call add_running_task()
    2. Executor sends heartbeats via HeartbeatManager.update_heartbeat()
    3. Scheduler periodically checks heartbeat status
    4. When task completes (callback received), call remove_running_task()
    """

    _instance: Optional["RunningTaskTracker"] = None
    _lock = threading.Lock()

    def __init__(self):
        """Initialize the RunningTaskTracker."""
        self._sync_client: Optional[redis.Redis] = None
        self._init_sync_redis()

    @classmethod
    def get_instance(cls) -> "RunningTaskTracker":
        """Get the singleton instance of RunningTaskTracker.

        Returns:
            The RunningTaskTracker singleton
        """
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _init_sync_redis(self) -> None:
        """Initialize synchronous Redis connection."""
        self._sync_client = RedisClientFactory.get_sync_client()
        if self._sync_client is not None:
            logger.info(
                "[RunningTaskTracker] Sync Redis connection established via factory"
            )
        else:
            logger.error("[RunningTaskTracker] Failed to connect to Redis via factory")

    def add_running_task(
        self,
        task_id: int,
        subtask_id: int,
        executor_name: str,
        task_type: str = "online",
    ) -> bool:
        """Add a task to the running tasks set.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            executor_name: Docker container name
            task_type: Task type (online, offline)

        Returns:
            True if added successfully
        """
        if self._sync_client is None:
            return False

        try:
            start_time = time.time()
            task_id_str = str(task_id)

            # Add to sorted set with start_time as score
            self._sync_client.zadd(RUNNING_TASKS_ZSET, {task_id_str: start_time})

            # Store task metadata in a hash
            meta_key = RUNNING_TASK_META_KEY.format(task_id=task_id)
            self._sync_client.hset(
                meta_key,
                mapping={
                    "task_id": str(task_id),
                    "subtask_id": str(subtask_id),
                    "executor_name": executor_name,
                    "task_type": task_type,
                    "start_time": str(start_time),
                },
            )
            # Set a long TTL (7 days) as safety net to prevent data leakage
            # if cleanup mechanisms fail. Normal cleanup happens via:
            # 1. Task completes (callback received) -> remove_running_task()
            # 2. Heartbeat timeout detected -> _handle_task_dead()
            # 3. Task cancelled -> remove_running_task()
            # 4. Executor deleted -> remove_running_task()
            ttl = int(os.getenv("RUNNING_TASK_META_TTL", "604800"))  # 7 days default
            self._sync_client.expire(meta_key, ttl)

            logger.info(
                f"[RunningTaskTracker] Added running task: task_id={task_id}, "
                f"subtask_id={subtask_id}, executor={executor_name}"
            )
            return True
        except Exception as e:
            logger.error(f"[RunningTaskTracker] Failed to add running task: {e}")
            return False

    def remove_running_task(self, task_id: int) -> bool:
        """Remove a task from the running tasks set.

        Called when a task completes (callback received) or is cancelled.

        Args:
            task_id: Task ID

        Returns:
            True if removed successfully
        """
        if self._sync_client is None:
            return False

        try:
            task_id_str = str(task_id)

            # Remove from sorted set
            self._sync_client.zrem(RUNNING_TASKS_ZSET, task_id_str)

            # Remove metadata hash
            meta_key = RUNNING_TASK_META_KEY.format(task_id=task_id)
            self._sync_client.delete(meta_key)

            logger.info(
                f"[RunningTaskTracker] Removed running task: task_id={task_id}, "
                f"deleted keys: {RUNNING_TASKS_ZSET} (zrem), {meta_key} (delete)"
            )
            return True
        except Exception as e:
            logger.error(f"[RunningTaskTracker] Failed to remove running task: {e}")
            return False

    def get_running_task_ids(self) -> List[str]:
        """Get all running task IDs.

        Returns:
            List of task_id strings
        """
        if self._sync_client is None:
            return []

        try:
            # Get all members from sorted set
            task_ids = self._sync_client.zrange(RUNNING_TASKS_ZSET, 0, -1)
            return [tid.decode() if isinstance(tid, bytes) else tid for tid in task_ids]
        except Exception as e:
            logger.error(f"[RunningTaskTracker] Failed to get running task IDs: {e}")
            return []

    def get_task_metadata(self, task_id: int) -> Optional[Dict[str, str]]:
        """Get metadata for a running task.

        Args:
            task_id: Task ID

        Returns:
            Task metadata dict or None if not found
        """
        if self._sync_client is None:
            return None

        try:
            meta_key = RUNNING_TASK_META_KEY.format(task_id=task_id)
            metadata = self._sync_client.hgetall(meta_key)
            if not metadata:
                return None

            # Decode bytes to strings
            return {
                (k.decode() if isinstance(k, bytes) else k): (
                    v.decode() if isinstance(v, bytes) else v
                )
                for k, v in metadata.items()
            }
        except Exception as e:
            logger.error(f"[RunningTaskTracker] Failed to get task metadata: {e}")
            return None

    def get_stale_tasks(self, max_age_seconds: int = None) -> List[Dict[str, Any]]:
        """Get tasks that have been running longer than max_age_seconds.

        This can be used to find tasks that might be stuck (not crashed,
        but running too long).

        Args:
            max_age_seconds: Maximum task age in seconds (default: DEFAULT_TASK_TIMEOUT)

        Returns:
            List of task metadata dicts for stale tasks
        """
        if self._sync_client is None:
            return []

        if max_age_seconds is None:
            max_age_seconds = DEFAULT_TASK_TIMEOUT

        try:
            cutoff_time = time.time() - max_age_seconds

            # Get tasks started before cutoff time
            # ZRANGEBYSCORE returns members with scores in the given range
            stale_task_ids = self._sync_client.zrangebyscore(
                RUNNING_TASKS_ZSET, "-inf", cutoff_time
            )

            tasks = []
            for task_id_bytes in stale_task_ids:
                task_id_str = (
                    task_id_bytes.decode()
                    if isinstance(task_id_bytes, bytes)
                    else task_id_bytes
                )
                try:
                    task_id = int(task_id_str)
                    metadata = self.get_task_metadata(task_id)
                    if metadata:
                        tasks.append(metadata)
                except ValueError:
                    continue

            return tasks
        except Exception as e:
            logger.error(f"[RunningTaskTracker] Failed to get stale tasks: {e}")
            return []

    # =========================================================================
    # Heartbeat Monitoring (for OOM detection)
    # =========================================================================

    async def check_heartbeats(self) -> None:
        """Check heartbeat status for running tasks that have passed grace period.

        If a task has not received a heartbeat within timeout,
        mark it as failed via Backend API callback.

        Uses distributed lock to prevent concurrent execution in multi-replica deployments.
        Only checks tasks older than grace_period to avoid false positives during startup.
        """
        from executor_manager.common.distributed_lock import get_distributed_lock
        from executor_manager.services.heartbeat_manager import (
            HeartbeatType,
            get_heartbeat_manager,
        )

        # Acquire distributed lock to prevent concurrent execution across multiple replicas
        lock = get_distributed_lock()
        if not lock.acquire("task_heartbeat_check", expire_seconds=30):
            logger.debug(
                "[RunningTaskTracker] Heartbeat check already running on another instance, skipping"
            )
            return

        try:
            heartbeat_mgr = get_heartbeat_manager()

            # Grace period from environment, default 30s (container startup time)
            grace_period = int(os.getenv("HEARTBEAT_GRACE_PERIOD", "30"))

            # Only get tasks started before (now - grace_period)
            # This filters out newly created tasks that haven't had time to send heartbeat
            eligible_tasks = self.get_stale_tasks(max_age_seconds=grace_period)
            if not eligible_tasks:
                return

            for task_meta in eligible_tasks:
                try:
                    task_id_str = task_meta.get("task_id", "")
                    if not task_id_str:
                        continue

                    # Check heartbeat - use TASK type for regular tasks
                    if not heartbeat_mgr.check_heartbeat(
                        task_id_str, HeartbeatType.TASK
                    ):
                        # Get last heartbeat time (may be None if key expired)
                        last_heartbeat = heartbeat_mgr.get_last_heartbeat(
                            task_id_str, HeartbeatType.TASK
                        )

                        # Task is old enough and missing heartbeat - means dead
                        executor_name = task_meta.get("executor_name", "")
                        subtask_id_str = task_meta.get("subtask_id", "0")
                        start_time_str = task_meta.get("start_time", "0")
                        try:
                            start_time = float(start_time_str)
                        except ValueError:
                            start_time = 0
                        task_age = time.time() - start_time

                        logger.warning(
                            f"[RunningTaskTracker] Heartbeat timeout for task {task_id_str}, "
                            f"age={task_age:.1f}s, last_heartbeat={last_heartbeat}, "
                            f"executor={executor_name}"
                        )
                        await self._handle_task_dead(
                            task_id_str=task_id_str,
                            subtask_id_str=subtask_id_str,
                            executor_name=executor_name,
                            last_heartbeat=last_heartbeat or start_time,
                        )

                except Exception as e:
                    logger.debug(
                        f"[RunningTaskTracker] Heartbeat check error for {task_meta}: {e}"
                    )
                    continue
        finally:
            lock.release("task_heartbeat_check")

    async def _handle_task_dead(
        self,
        task_id_str: str,
        subtask_id_str: str,
        executor_name: str,
        last_heartbeat: float,
    ) -> None:
        """Handle regular task executor death.

        Before marking task as failed, checks container status to determine:
        1. If container was OOM killed -> mark as OOM failure
        2. If container exited with error -> mark as crash failure
        3. If container doesn't exist -> check if task already completed
        4. If container still running -> likely network issue, skip

        Args:
            task_id_str: Task ID as string
            subtask_id_str: Subtask ID as string
            executor_name: Docker container name
            last_heartbeat: Last heartbeat timestamp
        """
        from executor_manager.clients.task_api_client import TaskApiClient
        from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
        from executor_manager.executors.dispatcher import ExecutorDispatcher
        from executor_manager.services.heartbeat_manager import (
            HeartbeatType,
            get_heartbeat_manager,
        )

        logger.info(
            f"[RunningTaskTracker] Checking task status: task_id={task_id_str}, "
            f"subtask_id={subtask_id_str}, executor={executor_name}"
        )

        heartbeat_mgr = get_heartbeat_manager()

        try:
            task_id = int(task_id_str)
            subtask_id = int(subtask_id_str)
        except ValueError:
            logger.error(
                f"[RunningTaskTracker] Invalid task_id or subtask_id: {task_id_str}, {subtask_id_str}"
            )
            return

        # Step 1: Check container/pod status via ExecutorDispatcher
        try:
            executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
            container_status = executor.get_container_status(executor_name)
        except Exception as e:
            logger.warning(f"[RunningTaskTracker] Failed to get container status: {e}")
            container_status = {
                "exists": False,
                "status": "error",
                "oom_killed": False,
                "exit_code": -1,
                "error_msg": str(e),
            }

        logger.info(
            f"[RunningTaskTracker] Container/Pod status for {executor_name}: {container_status}"
        )

        # Step 2: Handle based on container status
        if container_status["exists"] and container_status["status"] == "running":
            # Container is still running - likely a network issue with heartbeat
            # Don't mark as failed, just log a warning
            logger.warning(
                f"[RunningTaskTracker] Container {executor_name} is still running but "
                f"heartbeat timed out. Possible network issue, skipping failure marking."
            )
            return

        if not container_status["exists"]:
            # Container doesn't exist - check if task already completed via Backend
            try:
                api_client = TaskApiClient()
                task_status = api_client.get_task_status(task_id, subtask_id)

                if task_status and task_status.get("status") in (
                    "COMPLETED",
                    "FAILED",
                    "CANCELLED",
                ):
                    # Task already has a final status, just clean up tracker
                    logger.info(
                        f"[RunningTaskTracker] Task {task_id} already has status "
                        f"'{task_status.get('status')}', cleaning up tracker only (source: _handle_task_dead/already_final)"
                    )
                    heartbeat_mgr.delete_heartbeat(task_id_str, HeartbeatType.TASK)
                    self.remove_running_task(task_id)
                    return

                # Task is still in running state but container was deleted
                error_message = (
                    "Container was removed unexpectedly. "
                    "Task may have been cancelled or manually terminated."
                )
                logger.warning(
                    f"[RunningTaskTracker] Container {executor_name} not found, "
                    f"marking task {task_id} as failed"
                )
            except Exception as e:
                logger.warning(
                    f"[RunningTaskTracker] Failed to check task status from Backend: {e}"
                )
                error_message = (
                    "Container disappeared unexpectedly. " "Unable to determine cause."
                )
        else:
            # Container exists but not running (exited/dead/etc)
            if container_status["oom_killed"]:
                error_message = (
                    "Executor was killed due to Out Of Memory (OOM). "
                    "Please increase memory allocation for this task."
                )
                logger.warning(
                    f"[RunningTaskTracker] Container {executor_name} was OOM killed"
                )
            elif container_status["exit_code"] == 137:
                # Exit code 137 = 128 + 9 (SIGKILL), often indicates OOM
                error_message = (
                    "Executor was forcefully terminated (SIGKILL, exit code 137). "
                    "This is often caused by Out Of Memory. "
                    "Please check if your task requires more memory."
                )
                logger.warning(
                    f"[RunningTaskTracker] Container {executor_name} exited with code 137 (SIGKILL)"
                )
            elif container_status["exit_code"] == 0:
                # Normal exit - task might have completed but callback failed
                logger.info(
                    f"[RunningTaskTracker] Container {executor_name} exited normally (code 0), "
                    f"cleaning up tracker (source: _handle_task_dead/exit_code_0)"
                )
                heartbeat_mgr.delete_heartbeat(task_id_str, HeartbeatType.TASK)
                self.remove_running_task(task_id)
                return
            else:
                error_message = (
                    f"Executor crashed unexpectedly (exit code: {container_status['exit_code']}). "
                    "Please check the task logs for more details."
                )
                logger.warning(
                    f"[RunningTaskTracker] Container {executor_name} exited with code "
                    f"{container_status['exit_code']}"
                )

        # Step 3: Mark task as failed via Backend API
        try:
            api_client = TaskApiClient()
            success, result = api_client.update_task_status_by_fields(
                task_id=task_id,
                subtask_id=subtask_id,
                progress=0,
                status="FAILED",
                result={"value": error_message},
                error_message=error_message,
                executor_name=executor_name,
            )
            if success:
                logger.info(
                    f"[RunningTaskTracker] Marked task {task_id} as failed via Backend API"
                )
            else:
                logger.warning(
                    f"[RunningTaskTracker] Failed to mark task {task_id} as failed: {result}"
                )
        except Exception as e:
            logger.error(f"[RunningTaskTracker] Error calling Backend API: {e}")

        # Step 4: Clean up
        logger.info(
            f"[RunningTaskTracker] Cleaning up task {task_id} after marking as failed "
            f"(source: _handle_task_dead/marked_failed)"
        )
        heartbeat_mgr.delete_heartbeat(task_id_str, HeartbeatType.TASK)
        self.remove_running_task(task_id)

        # Step 5: Optionally delete container (for OOM debugging, keep by default)
        delete_zombie_containers = os.getenv(
            "DELETE_ZOMBIE_CONTAINERS", "false"
        ).lower() in ("true", "1", "yes")

        if container_status["exists"] and delete_zombie_containers:
            try:
                executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
                result = executor.delete_executor(executor_name)
                if result.get("status") != "success":
                    logger.warning(
                        f"[RunningTaskTracker] Failed to delete container {executor_name}: "
                        f"{result.get('error_msg')}"
                    )
                else:
                    logger.info(
                        f"[RunningTaskTracker] Deleted zombie container {executor_name}"
                    )
            except Exception as e:
                logger.warning(f"[RunningTaskTracker] Error deleting container: {e}")
        elif container_status["exists"]:
            logger.info(
                f"[RunningTaskTracker] Container {executor_name} preserved for debugging. "
                f"Set DELETE_ZOMBIE_CONTAINERS=true to auto-delete."
            )


# Global singleton instance
_running_task_tracker: Optional[RunningTaskTracker] = None


def get_running_task_tracker() -> RunningTaskTracker:
    """Get the global RunningTaskTracker instance.

    Returns:
        The RunningTaskTracker singleton
    """
    global _running_task_tracker
    if _running_task_tracker is None:
        _running_task_tracker = RunningTaskTracker.get_instance()
    return _running_task_tracker
