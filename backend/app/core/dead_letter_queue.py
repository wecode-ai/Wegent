# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Dead Letter Queue (DLQ) implementation for failed Celery tasks.

This module provides:
1. Signal handlers to capture failed tasks after max retries
2. Storage of failed task information in Redis for later inspection
3. APIs to query and reprocess failed tasks

The DLQ helps with:
- Debugging: See why tasks failed with full context
- Monitoring: Track failure patterns and rates
- Recovery: Manually reprocess failed tasks after fixing issues
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from celery import current_app
from celery.signals import task_failure, task_rejected, task_revoked
from prometheus_client import Counter, Gauge
from redis import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Redis key prefix for DLQ
DLQ_KEY_PREFIX = "celery:dlq:"
DLQ_LIST_KEY = "celery:dlq:list"
DLQ_TTL_SECONDS = 60 * 60 * 24 * 7  # Keep failed tasks for 7 days

# Prometheus metrics
DLQ_SIZE = Gauge(
    "celery_dlq_size",
    "Number of tasks in dead letter queue",
)
DLQ_TASKS_ADDED = Counter(
    "celery_dlq_tasks_added_total",
    "Total tasks added to dead letter queue",
    ["task_name"],
)
DLQ_TASKS_REPROCESSED = Counter(
    "celery_dlq_tasks_reprocessed_total",
    "Total tasks reprocessed from dead letter queue",
    ["task_name"],
)


def _get_redis_client() -> Redis:
    """Get Redis client for DLQ operations."""
    redis_url = settings.CELERY_BROKER_URL or settings.REDIS_URL
    return Redis.from_url(redis_url, decode_responses=True)


def _serialize_exception(exc: Exception) -> Dict[str, Any]:
    """Serialize exception for storage."""
    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "args": [str(arg) for arg in exc.args] if exc.args else [],
    }


def add_to_dlq(
    task_id: str,
    task_name: str,
    args: tuple,
    kwargs: dict,
    exception: Exception,
    traceback_str: Optional[str] = None,
    retries: int = 0,
) -> str:
    """
    Add a failed task to the dead letter queue.

    Args:
        task_id: Celery task ID
        task_name: Name of the task
        args: Task positional arguments
        kwargs: Task keyword arguments
        exception: The exception that caused the failure
        traceback_str: Optional traceback string
        retries: Number of retries attempted

    Returns:
        str: DLQ entry ID
    """
    redis_client = _get_redis_client()

    dlq_entry = {
        "task_id": task_id,
        "task_name": task_name,
        "args": list(args) if args else [],
        "kwargs": kwargs or {},
        "exception": _serialize_exception(exception),
        "traceback": traceback_str,
        "retries": retries,
        "failed_at": datetime.now(timezone.utc).isoformat(),
        "status": "failed",
    }

    # Store the entry
    entry_key = f"{DLQ_KEY_PREFIX}{task_id}"
    redis_client.setex(entry_key, DLQ_TTL_SECONDS, json.dumps(dlq_entry))

    # Add to the list for easy querying
    redis_client.lpush(DLQ_LIST_KEY, task_id)
    redis_client.ltrim(DLQ_LIST_KEY, 0, 999)  # Keep last 1000 entries

    # Update metrics
    DLQ_TASKS_ADDED.labels(task_name=task_name).inc()

    # Update gauge (approximate, may have race conditions)
    dlq_size = redis_client.llen(DLQ_LIST_KEY)
    DLQ_SIZE.set(dlq_size)

    logger.warning(
        f"[DLQ] Task added to dead letter queue: {task_name} ({task_id})",
        extra={
            "task_id": task_id,
            "task_name": task_name,
            "exception": str(exception),
        },
    )

    return task_id


def get_dlq_tasks(
    limit: int = 50,
    offset: int = 0,
    task_name: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Get tasks from the dead letter queue.

    Args:
        limit: Maximum number of tasks to return
        offset: Offset for pagination
        task_name: Optional filter by task name

    Returns:
        List of DLQ entries
    """
    redis_client = _get_redis_client()

    # Get task IDs from the list
    task_ids = redis_client.lrange(DLQ_LIST_KEY, offset, offset + limit - 1)

    tasks = []
    for task_id in task_ids:
        entry_key = f"{DLQ_KEY_PREFIX}{task_id}"
        entry_data = redis_client.get(entry_key)
        if entry_data:
            entry = json.loads(entry_data)
            if task_name is None or entry.get("task_name") == task_name:
                tasks.append(entry)

    return tasks


def get_dlq_task(task_id: str) -> Optional[Dict[str, Any]]:
    """
    Get a specific task from the dead letter queue.

    Args:
        task_id: Celery task ID

    Returns:
        DLQ entry or None if not found
    """
    redis_client = _get_redis_client()
    entry_key = f"{DLQ_KEY_PREFIX}{task_id}"
    entry_data = redis_client.get(entry_key)

    if entry_data:
        return json.loads(entry_data)
    return None


def reprocess_dlq_task(task_id: str) -> Optional[str]:
    """
    Reprocess a task from the dead letter queue.

    Args:
        task_id: Celery task ID to reprocess

    Returns:
        New task ID if successful, None otherwise
    """
    entry = get_dlq_task(task_id)
    if not entry:
        logger.error(f"[DLQ] Task not found in DLQ: {task_id}")
        return None

    task_name = entry["task_name"]
    args = entry["args"]
    kwargs = entry["kwargs"]

    try:
        # Get the task class and send it
        task = current_app.tasks.get(task_name)
        if not task:
            logger.error(f"[DLQ] Task class not found: {task_name}")
            return None

        # Send the task with fresh retry count
        result = task.apply_async(args=args, kwargs=kwargs)

        # Update the DLQ entry
        redis_client = _get_redis_client()
        entry["status"] = "reprocessed"
        entry["reprocessed_at"] = datetime.now(timezone.utc).isoformat()
        entry["new_task_id"] = result.id

        entry_key = f"{DLQ_KEY_PREFIX}{task_id}"
        redis_client.setex(entry_key, DLQ_TTL_SECONDS, json.dumps(entry))

        # Update metrics
        DLQ_TASKS_REPROCESSED.labels(task_name=task_name).inc()

        logger.info(
            f"[DLQ] Task reprocessed: {task_name} ({task_id}) -> {result.id}",
            extra={
                "original_task_id": task_id,
                "new_task_id": result.id,
                "task_name": task_name,
            },
        )

        return result.id

    except Exception as e:
        logger.error(f"[DLQ] Failed to reprocess task {task_id}: {e}")
        return None


def remove_from_dlq(task_id: str) -> bool:
    """
    Remove a task from the dead letter queue.

    Args:
        task_id: Celery task ID to remove

    Returns:
        True if removed, False otherwise
    """
    redis_client = _get_redis_client()

    # Remove the entry
    entry_key = f"{DLQ_KEY_PREFIX}{task_id}"
    deleted = redis_client.delete(entry_key)

    # Remove from the list
    redis_client.lrem(DLQ_LIST_KEY, 0, task_id)

    # Update gauge
    dlq_size = redis_client.llen(DLQ_LIST_KEY)
    DLQ_SIZE.set(dlq_size)

    return deleted > 0


def get_dlq_stats() -> Dict[str, Any]:
    """
    Get statistics about the dead letter queue.

    Returns:
        Dictionary with DLQ statistics
    """
    redis_client = _get_redis_client()

    total = redis_client.llen(DLQ_LIST_KEY)

    # Get task name distribution (sample first 100)
    task_ids = redis_client.lrange(DLQ_LIST_KEY, 0, 99)
    task_counts: Dict[str, int] = {}

    for task_id in task_ids:
        entry_key = f"{DLQ_KEY_PREFIX}{task_id}"
        entry_data = redis_client.get(entry_key)
        if entry_data:
            entry = json.loads(entry_data)
            task_name = entry.get("task_name", "unknown")
            task_counts[task_name] = task_counts.get(task_name, 0) + 1

    return {
        "total": total,
        "by_task_name": task_counts,
        "ttl_days": DLQ_TTL_SECONDS // (60 * 60 * 24),
    }


# ============================================================
# Celery Signal Handlers
# ============================================================


@task_failure.connect
def handle_task_failure(
    sender=None,
    task_id=None,
    exception=None,
    args=None,
    kwargs=None,
    traceback=None,
    einfo=None,
    **kw,
):
    """
    Signal handler for task failures.

    This is called when a task raises an exception.
    We only add to DLQ if retries are exhausted.
    """
    task_name = sender.name if sender else "unknown"

    # Check if retries are exhausted
    # Note: This signal is called on every failure, including retries
    # We use the task's request to check retry count
    try:
        request = sender.request if sender else None
        retries = request.retries if request else 0
        max_retries = sender.max_retries if sender else 3

        # Only add to DLQ if this was the final retry
        if retries >= max_retries:
            traceback_str = str(traceback) if traceback else None
            add_to_dlq(
                task_id=task_id,
                task_name=task_name,
                args=args or (),
                kwargs=kwargs or {},
                exception=exception,
                traceback_str=traceback_str,
                retries=retries,
            )
            logger.error(
                f"[DLQ] Task failed after {retries} retries, added to DLQ: {task_name} ({task_id})"
            )
        else:
            logger.warning(
                f"[DLQ] Task failed, will retry ({retries}/{max_retries}): {task_name} ({task_id})"
            )

    except Exception as e:
        logger.error(f"[DLQ] Error in task_failure handler: {e}")


@task_rejected.connect
def handle_task_rejected(
    sender=None,
    message=None,
    exc=None,
    **kw,
):
    """
    Signal handler for rejected tasks.

    Tasks are rejected when they raise an exception that should not be retried.
    """
    task_id = (
        message.delivery_info.get("routing_key", "unknown") if message else "unknown"
    )
    logger.warning(f"[DLQ] Task rejected: {task_id}, exception: {exc}")


@task_revoked.connect
def handle_task_revoked(
    sender=None,
    request=None,
    terminated=None,
    signum=None,
    expired=None,
    **kw,
):
    """
    Signal handler for revoked/terminated tasks.

    This is called when a task is revoked or terminated (e.g., timeout).
    """
    task_id = request.id if request else "unknown"
    task_name = sender.name if sender else "unknown"

    reason = "unknown"
    if expired:
        reason = "expired"
    elif terminated:
        reason = f"terminated (signal {signum})"

    logger.warning(f"[DLQ] Task revoked: {task_name} ({task_id}), reason: {reason}")
