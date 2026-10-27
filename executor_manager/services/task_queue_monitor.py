#
# SPDX-License-Identifier: Apache-2.0

"""Detect queued tasks that never reached an executor.

``/v1/responses`` enqueues work and returns immediately. If the queue item is
lost, or a consumer pops it and dies before creating the Pod, the backend
subtask stays RUNNING with no events. This monitor tracks every enqueued task
in Redis and fails the ones that are neither queued nor running after a grace
period, so the user sees a terminal error instead of a hang.
"""

import json
import os
import time
from typing import Any, Dict, List, Optional, Set

from executor_manager.services.task_queue_service import (
    PENDING_KEY_TEMPLATE,
    TaskQueueService,
)
from shared.logger import setup_logger

logger = setup_logger(__name__)

DEFAULT_STALL_TIMEOUT = int(os.getenv("TASK_QUEUE_STALL_TIMEOUT", "600"))


class TaskQueueMonitor:
    """Sweep pending queue records and fail tasks that never started."""

    def __init__(
        self,
        *,
        stall_timeout_seconds: int = DEFAULT_STALL_TIMEOUT,
        queue_service: Optional[TaskQueueService] = None,
    ) -> None:
        self._stall_timeout = stall_timeout_seconds
        self._queue_service = queue_service

    @property
    def queue_service(self) -> TaskQueueService:
        if self._queue_service is None:
            self._queue_service = TaskQueueService()
        return self._queue_service

    async def sweep(self) -> List[str]:
        """Fail stalled pending tasks and return their task ids."""
        client = self.queue_service.redis_client
        if not client:
            return []

        now = time.time()
        stalled: List[str] = []
        queued_cache: Dict[str, Optional[Set[str]]] = {}
        for key in client.scan_iter(
            PENDING_KEY_TEMPLATE.format(task_id="*"), count=200
        ):
            payload = self._load(client, key)
            if payload is None:
                continue
            if now - float(payload.get("enqueued_at") or now) < self._stall_timeout:
                continue
            if self._still_queued(client, payload, queued_cache):
                continue
            if await self._fail_task(payload):
                stalled.append(payload["task_id"])
                client.delete(key)
        return stalled

    @staticmethod
    def _load(client, key: Any) -> Optional[Dict[str, Any]]:
        try:
            raw = client.get(key)
            if not raw:
                return None
            payload = json.loads(raw)
        except Exception as exc:
            logger.warning(
                "[TaskQueueMonitor] Unreadable pending record %s: %s", key, exc
            )
            return None
        if not payload.get("task_id") or not payload.get("subtask_id"):
            return None
        return payload

    @staticmethod
    def _still_queued(
        client,
        payload: Dict[str, Any],
        queued_cache: Dict[str, Optional[Set[str]]],
    ) -> bool:
        """Return True when the item is simply waiting behind backpressure."""
        queue_key = payload.get("queue_key")
        task_id = str(payload.get("task_id"))
        if not queue_key:
            return False
        if queue_key not in queued_cache:
            queued_cache[queue_key] = TaskQueueMonitor._queued_task_ids(
                client, queue_key
            )
        queued = queued_cache[queue_key]
        if queued is None:
            # Unknown queue state must not fail tasks that may still be waiting.
            return True
        return task_id in queued

    @staticmethod
    def _queued_task_ids(client, queue_key: str) -> Optional[Set[str]]:
        """Snapshot the task ids currently waiting in one queue."""
        if not client.llen(queue_key):
            return set()
        try:
            task_ids: Set[str] = set()
            for raw in client.lrange(queue_key, 0, -1):
                try:
                    task_id = (json.loads(raw) or {}).get("task_id")
                except json.JSONDecodeError:
                    continue
                if task_id is not None:
                    task_ids.add(str(task_id))
            return task_ids
        except Exception as exc:
            logger.warning(
                "[TaskQueueMonitor] Failed to inspect %s: %s", queue_key, exc
            )
            return None

    async def _fail_task(self, payload: Dict[str, Any]) -> bool:
        from executor_manager.clients.callback_client import get_callback_client

        task_id = int(payload["task_id"])
        subtask_id = int(payload["subtask_id"])
        queued_for = time.time() - float(payload.get("enqueued_at") or time.time())
        started = payload.get("dequeued_at") is not None
        error_message = (
            "任务已从队列取出但执行器始终未启动，已判定失败。请重新发起。"
            if started
            else "任务入队后长时间未被调度执行，已判定失败。请重新发起。"
        )
        logger.error(
            "[TaskQueueMonitor] STALLED task_id=%s subtask_id=%s queued_for=%.0fs "
            "dequeued=%s queue=%s",
            task_id,
            subtask_id,
            queued_for,
            started,
            payload.get("queue_key"),
        )
        try:
            return await get_callback_client().send_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error_message=error_message,
                error_code="task_queue_stalled",
            )
        except Exception as exc:
            logger.error(
                "[TaskQueueMonitor] Failed to report stalled task %s: %s",
                task_id,
                exc,
            )
            return False


async def run_queue_stall_check() -> None:
    """Scheduler entry point."""
    stalled = await TaskQueueMonitor().sweep()
    if stalled:
        logger.error(
            "[TaskQueueMonitor] Failed %d stalled queued tasks: %s",
            len(stalled),
            stalled,
        )


__all__ = ["TaskQueueMonitor", "run_queue_stall_check"]
