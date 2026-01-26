#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""Task queue consumer with backpressure control.

This module provides a consumer that processes tasks from Redis queue
with backpressure control based on current executor capacity.
"""

import os
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional

from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.config.config import (
    EXECUTOR_DISPATCHER_MODE,
    OFFLINE_TASK_EVENING_HOURS,
    OFFLINE_TASK_MORNING_HOURS,
)
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.services.task_queue_service import TaskQueueService
from executor_manager.tasks.task_processor import TaskProcessor
from shared.logger import setup_logger

logger = setup_logger(__name__)


class TaskQueueConsumer:
    """Consumer that processes tasks from Redis queue with backpressure.

    This consumer runs in a background thread and continuously polls
    the Redis queue for tasks. It respects the MAX_CONCURRENT_TASKS
    limit to avoid overloading the executor infrastructure.

    For offline queue, it only processes tasks during the configured
    time window (default: 21:00-08:00).
    """

    def __init__(self, service_pool: str = "default", queue_type: str = "online"):
        """Initialize the task queue consumer.

        Args:
            service_pool: Service pool name to consume from
            queue_type: Queue type ('online' or 'offline')
        """
        self.service_pool = service_pool
        self.queue_type = queue_type
        self.queue_service = TaskQueueService(service_pool, queue_type)
        self.task_processor = TaskProcessor()
        self.api_client = TaskApiClient()
        self.running = False
        self.max_concurrent_tasks = int(os.getenv("MAX_CONCURRENT_TASKS", "30"))
        self._thread: Optional[threading.Thread] = None

        # Backpressure configuration
        self._backpressure_wait = float(
            os.getenv("TASK_QUEUE_BACKPRESSURE_WAIT", "1.0")
        )
        self._dequeue_timeout = int(os.getenv("TASK_QUEUE_DEQUEUE_TIMEOUT", "5"))

        # Capacity check cache to avoid frequent Docker API calls
        self._capacity_cache_ttl = float(
            os.getenv("TASK_QUEUE_CAPACITY_CACHE_TTL", "1.0")
        )
        self._last_capacity_check: float = 0
        self._cached_capacity: bool = True

        # Parse offline time windows
        self._offline_evening_hours = self._parse_hour_range(OFFLINE_TASK_EVENING_HOURS)
        self._offline_morning_hours = self._parse_hour_range(OFFLINE_TASK_MORNING_HOURS)

    def _parse_hour_range(self, hour_range: str) -> tuple:
        """Parse hour range string like '21-23' to tuple (21, 23)."""
        try:
            parts = hour_range.split("-")
            return (int(parts[0]), int(parts[1]))
        except (ValueError, IndexError):
            return (0, 0)

    def _is_offline_time_window(self) -> bool:
        """Check if current time is within offline task processing window.

        Returns:
            True if within offline time window (21:00-23:59 or 00:00-08:00)
        """
        current_hour = datetime.now().hour
        evening_start, evening_end = self._offline_evening_hours
        morning_start, morning_end = self._offline_morning_hours

        # Evening: 21-23 means hours 21, 22, 23
        if evening_start <= current_hour <= evening_end:
            return True

        # Morning: 0-8 means hours 0, 1, 2, 3, 4, 5, 6, 7, 8
        if morning_start <= current_hour <= morning_end:
            return True

        return False

    def start(self) -> None:
        """Start consuming tasks in background thread."""
        if self.running:
            logger.warning("[TaskQueueConsumer] Already running")
            return

        self.running = True
        self._thread = threading.Thread(target=self._consume_loop, daemon=True)
        self._thread.start()
        logger.info(
            f"[TaskQueueConsumer] Started for pool '{self.service_pool}' "
            f"queue_type='{self.queue_type}' (max_concurrent={self.max_concurrent_tasks})"
        )

    def stop(self) -> None:
        """Stop the consumer gracefully."""
        if not self.running:
            return

        logger.info("[TaskQueueConsumer] Stopping...")
        self.running = False

        if self._thread:
            self._thread.join(timeout=10)
            if self._thread.is_alive():
                logger.warning("[TaskQueueConsumer] Thread did not stop in time")
            self._thread = None

        logger.info("[TaskQueueConsumer] Stopped")

    def _consume_loop(self) -> None:
        """Main consumption loop with backpressure."""
        logger.info(
            f"[TaskQueueConsumer] Consume loop started (queue_type={self.queue_type})"
        )

        while self.running:
            try:
                # Set request context for log correlation (new ID per iteration)
                from shared.telemetry.context import init_request_context

                init_request_context()

                # Offline queue time window check
                # Only process offline tasks during configured hours (21:00-08:00)
                if self.queue_type == "offline" and not self._is_offline_time_window():
                    logger.debug(
                        "[TaskQueueConsumer] Outside offline time window, sleeping for 60s"
                    )
                    time.sleep(60)  # Sleep longer when outside window
                    continue

                # Backpressure check
                if not self._has_capacity():
                    queue_len = self.queue_service.get_queue_length()
                    logger.debug(
                        f"[TaskQueueConsumer] At capacity, waiting... "
                        f"(queue_length={queue_len})"
                    )
                    time.sleep(self._backpressure_wait)
                    continue

                # Dequeue with timeout
                task = self.queue_service.dequeue_task(timeout=self._dequeue_timeout)
                if task:
                    self._process_task_with_retry(task)

            except Exception as e:
                logger.error(f"[TaskQueueConsumer] Error in consume loop: {e}")
                time.sleep(1)  # Avoid tight loop on persistent errors

        logger.info("[TaskQueueConsumer] Consume loop ended")

    def _process_task_with_retry(self, task: Dict[str, Any]) -> None:
        """Process a task with retry logic.

        If processing fails:
        - Retry count < max_retries: requeue the task
        - Retry count >= max_retries: mark as FAILED and callback

        Args:
            task: Task dictionary to process
        """
        task_id = task.get("task_id", "unknown")
        subtask_id = task.get("subtask_id", "unknown")
        retry_count = TaskQueueService.get_retry_count(task)

        if retry_count > 0:
            logger.info(
                f"[TaskQueueConsumer] Processing task_id={task_id} subtask_id={subtask_id} "
                f"(queue={self.queue_type}, retry {retry_count})"
            )
        else:
            logger.info(
                f"[TaskQueueConsumer] Processing task_id={task_id} subtask_id={subtask_id} "
                f"(queue={self.queue_type})"
            )

        try:
            result = self.task_processor.process_tasks([task])

            # Check if task processing actually succeeded
            task_result = result.get(task_id, {}) if isinstance(result, dict) else {}
            if isinstance(task_result, dict) and task_result.get("executor_name"):
                # Success - executor was created
                return

            # No executor_name means submission failed
            error_msg = (
                task_result.get("error_msg", "Unknown error")
                if isinstance(task_result, dict)
                else "Task processing returned unexpected result"
            )
            self._handle_task_failure(task, error_msg)

        except Exception as e:
            logger.error(
                f"[TaskQueueConsumer] Exception processing task "
                f"{task_id}/{subtask_id}: {e}"
            )
            self._handle_task_failure(task, str(e))

    def _handle_task_failure(self, task: Dict[str, Any], error_msg: str) -> None:
        """Handle a failed task - retry or mark as failed.

        Args:
            task: Failed task dictionary
            error_msg: Error message describing the failure
        """
        task_id = task.get("task_id")
        subtask_id = task.get("subtask_id")

        # Try to requeue
        should_retry, retry_count = self.queue_service.requeue_task(task)

        if should_retry:
            logger.info(
                f"[TaskQueueConsumer] Task {task_id}/{subtask_id} requeued for retry"
            )
            return

        # Max retries exceeded - mark as FAILED
        logger.error(
            f"[TaskQueueConsumer] Task {task_id}/{subtask_id} failed after "
            f"{retry_count} retries: {error_msg}"
        )

        # Callback to update task status to FAILED
        if task_id and subtask_id:
            try:
                success, result = self.api_client.update_task_status_by_fields(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    progress=0,
                    status="FAILED",
                    error_message=f"Task failed after {retry_count} retries: {error_msg}",
                )
                if success:
                    logger.info(
                        f"[TaskQueueConsumer] Task {task_id}/{subtask_id} marked as FAILED"
                    )
                else:
                    logger.warning(
                        f"[TaskQueueConsumer] Failed to update task {task_id}/{subtask_id} "
                        f"status: {result}"
                    )
            except Exception as e:
                logger.error(
                    f"[TaskQueueConsumer] Error updating task {task_id}/{subtask_id} "
                    f"status: {e}"
                )

    def _has_capacity(self) -> bool:
        """Check if current executor count is below MAX_CONCURRENT_TASKS.

        Uses a cache to avoid frequent Docker API calls. The cache is valid
        for _capacity_cache_ttl seconds (default 1s).

        Returns:
            True if there is capacity for more tasks, False otherwise
        """
        now = time.time()

        # Return cached result if still valid
        if now - self._last_capacity_check < self._capacity_cache_ttl:
            return self._cached_capacity

        start_time = time.time()
        try:
            executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
            result = executor.get_executor_count()
            elapsed = time.time() - start_time
            running = result.get("running", 0)
            has_capacity = running < self.max_concurrent_tasks

            # Update cache
            self._last_capacity_check = now
            self._cached_capacity = has_capacity

            logger.info(
                f"[TaskQueueConsumer] Capacity check: {running}/{self.max_concurrent_tasks} "
                f"(took {elapsed:.2f}s, has_capacity={has_capacity})"
            )

            return has_capacity

        except Exception as e:
            logger.warning(
                f"[TaskQueueConsumer] Failed to check capacity: {e}, assuming available"
            )
            # Assume capacity available on error to avoid blocking
            return True

    def get_status(self) -> dict:
        """Get consumer status for monitoring.

        Returns:
            Status dictionary with queue length, running state, etc.
        """
        try:
            executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
            executor_result = executor.get_executor_count()
            running_executors = executor_result.get("running", 0)
        except Exception:
            running_executors = -1

        return {
            "running": self.running,
            "service_pool": self.service_pool,
            "queue_length": self.queue_service.get_queue_length(),
            "max_concurrent_tasks": self.max_concurrent_tasks,
            "current_executors": running_executors,
            "has_capacity": (
                running_executors < self.max_concurrent_tasks
                if running_executors >= 0
                else True
            ),
        }
