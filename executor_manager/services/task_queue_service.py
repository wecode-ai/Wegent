#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""Redis-based task queue service for push mode.

This module provides a task queue service that uses Redis Lists for
FIFO task queuing with support for multiple service pools.
"""

import json
import os
from typing import Any, Dict, List, Optional

from executor_manager.common.redis_factory import RedisClientFactory
from shared.logger import setup_logger

logger = setup_logger(__name__)

# Queue key prefix
QUEUE_KEY_PREFIX = "wegent:task_queue"

# Retry configuration
DEFAULT_MAX_RETRIES = 3
RETRY_COUNT_FIELD = "_retry_count"


class TaskQueueService:
    """Redis-based task queue service with service pool support.

    Each service pool (e.g., 'default', 'canary') has its own queue,
    ensuring task isolation between pools for grayscale deployments.

    Queue key format: wegent:task_queue:{queue_type}:{service_pool}
    - queue_type: 'online' or 'offline'
    - service_pool: 'default', 'canary', etc.
    """

    def __init__(self, service_pool: str = "default", queue_type: str = "online"):
        """Initialize the task queue service.

        Args:
            service_pool: Service pool name (e.g., 'default', 'canary')
            queue_type: Queue type ('online' or 'offline')
        """
        self.service_pool = service_pool
        self.queue_type = queue_type
        self.queue_key = f"{QUEUE_KEY_PREFIX}:{queue_type}:{service_pool}"
        self._redis_client = None
        self.max_retries = int(
            os.getenv("TASK_QUEUE_MAX_RETRIES", str(DEFAULT_MAX_RETRIES))
        )

    @property
    def redis_client(self):
        """Get or create Redis client."""
        if self._redis_client is None:
            self._redis_client = RedisClientFactory.get_sync_client()
        return self._redis_client

    def enqueue_task(self, task: Dict[str, Any]) -> bool:
        """Push task to queue.

        Uses LPUSH for FIFO behavior when combined with BRPOP.

        Args:
            task: Task dictionary to enqueue

        Returns:
            True if successful, False otherwise
        """
        if not self.redis_client:
            logger.error("[TaskQueue] Redis client not available")
            return False

        try:
            task_json = json.dumps(task)
            self.redis_client.lpush(self.queue_key, task_json)
            task_id = task.get("task_id", "unknown")
            subtask_id = task.get("subtask_id", "unknown")
            logger.info(
                f"[TaskQueue] Enqueued task task_id:{task_id} subtask_id:{subtask_id} to {self.queue_key}"
            )
            return True
        except Exception as e:
            logger.error(f"[TaskQueue] Failed to enqueue task: {e}")
            return False

    def enqueue_tasks(self, tasks: List[Dict[str, Any]]) -> int:
        """Push multiple tasks to queue.

        Args:
            tasks: List of task dictionaries to enqueue

        Returns:
            Number of successfully enqueued tasks
        """
        if not self.redis_client:
            logger.error("[TaskQueue] Redis client not available")
            return 0

        success_count = 0
        for task in tasks:
            if self.enqueue_task(task):
                success_count += 1

        logger.info(
            f"[TaskQueue] Enqueued success_count={success_count} out of {len(tasks)} tasks to {self.queue_key}"
        )
        return success_count

    def dequeue_task(self, timeout: int = 5) -> Optional[Dict[str, Any]]:
        """Pop task from queue with blocking wait.

        Uses BRPOP for blocking pop from right side (FIFO with LPUSH).

        Args:
            timeout: Seconds to wait for task (0 for indefinite)

        Returns:
            Task dictionary if available, None otherwise
        """
        if not self.redis_client:
            logger.warning("[TaskQueue] Redis client not available for dequeue")
            return None

        try:
            result = self.redis_client.brpop(self.queue_key, timeout=timeout)
            if result:
                _, task_json = result
                task = json.loads(task_json)
                task_id = task.get("task_id", "unknown")
                subtask_id = task.get("subtask_id", "unknown")
                logger.debug(
                    f"[TaskQueue] Dequeued task {task_id}/{subtask_id} from {self.queue_key}"
                )
                return task
            return None
        except Exception as e:
            logger.error(f"[TaskQueue] Failed to dequeue task: {e}")
            return None

    def get_queue_length(self) -> int:
        """Get current queue length for monitoring.

        Returns:
            Number of tasks in queue, 0 if error
        """
        if not self.redis_client:
            return 0

        try:
            return self.redis_client.llen(self.queue_key)
        except Exception as e:
            logger.error(f"[TaskQueue] Failed to get queue length: {e}")
            return 0

    def peek_tasks(self, count: int = 10) -> List[Dict[str, Any]]:
        """Peek at tasks in queue without removing them.

        Useful for monitoring and debugging.

        Args:
            count: Maximum number of tasks to peek

        Returns:
            List of task dictionaries (oldest first)
        """
        if not self.redis_client:
            return []

        try:
            # LRANGE with negative indices gets from right (oldest)
            task_jsons = self.redis_client.lrange(self.queue_key, -count, -1)
            tasks = []
            for task_json in task_jsons:
                try:
                    tasks.append(json.loads(task_json))
                except json.JSONDecodeError:
                    continue
            return tasks
        except Exception as e:
            logger.error(f"[TaskQueue] Failed to peek tasks: {e}")
            return []

    def clear_queue(self) -> bool:
        """Clear all tasks from queue.

        WARNING: This is destructive. Use only for testing or emergency cleanup.

        Returns:
            True if successful, False otherwise
        """
        if not self.redis_client:
            return False

        try:
            self.redis_client.delete(self.queue_key)
            logger.warning(f"[TaskQueue] Cleared queue {self.queue_key}")
            return True
        except Exception as e:
            logger.error(f"[TaskQueue] Failed to clear queue: {e}")
            return False

    def requeue_task(self, task: Dict[str, Any]) -> tuple[bool, int]:
        """Requeue a failed task with incremented retry count.

        Args:
            task: Task dictionary to requeue

        Returns:
            Tuple of (should_retry: bool, retry_count: int)
            - should_retry: True if task was requeued, False if max retries exceeded
            - retry_count: Current retry count after increment
        """
        retry_count = task.get(RETRY_COUNT_FIELD, 0) + 1
        task[RETRY_COUNT_FIELD] = retry_count

        task_id = task.get("task_id", "unknown")
        subtask_id = task.get("subtask_id", "unknown")

        if retry_count > self.max_retries:
            logger.warning(
                f"[TaskQueue] Task {task_id}/{subtask_id} exceeded max retries "
                f"({retry_count}/{self.max_retries}), not requeuing"
            )
            return False, retry_count

        if self.enqueue_task(task):
            logger.info(
                f"[TaskQueue] Requeued task {task_id}/{subtask_id} "
                f"(retry {retry_count}/{self.max_retries})"
            )
            return True, retry_count

        logger.error(f"[TaskQueue] Failed to requeue task {task_id}/{subtask_id}")
        return False, retry_count

    @staticmethod
    def get_retry_count(task: Dict[str, Any]) -> int:
        """Get current retry count from task.

        Args:
            task: Task dictionary

        Returns:
            Current retry count (0 if never retried)
        """
        return task.get(RETRY_COUNT_FIELD, 0)
