# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor liveness checks shared by every dispatch path."""

import asyncio
import logging
from typing import Optional

from app.core.config import settings
from shared.telemetry.decorators import add_span_event, trace_async
from shared.utils.http_client import traced_async_client

logger = logging.getLogger(__name__)


@trace_async("execution.executor_pod_missing", "execution.schedule")
async def executor_pod_missing(
    executor_name: str,
    executor_namespace: str | None,
) -> bool:
    """Return True when executor_manager confirms the executor cannot serve tasks.

    Wraps ``remote_workspace_service.executor_alive`` in a thread because the
    underlying httpx call is synchronous. Any transport/decoding failure is
    treated as "pod still alive" so dispatch surfaces the real error instead
    of triggering a spurious recovery. A pod that exists but has reached a
    terminal phase (Succeeded/Failed) also returns True so dispatch recreates it.
    """
    from app.services.remote_workspace_service import remote_workspace_service

    try:
        alive = await asyncio.to_thread(
            remote_workspace_service.executor_alive,
            executor_name,
            executor_namespace,
        )
    except Exception as exc:
        logger.warning(
            "[executor_health] executor_alive check failed executor=%s/%s error=%s",
            executor_namespace,
            executor_name,
            exc,
        )
        add_span_event(
            "execution.executor_pod_missing.check_failed",
            {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace or "",
                "error": str(exc),
            },
        )
        return False
    return not alive


@trace_async("execution.executor_heartbeat_alive", "execution.schedule")
async def executor_heartbeat_alive(task_id: int) -> Optional[bool]:
    """Return the executor heartbeat state, or ``None`` when unknown.

    ``None`` is deliberately distinct from ``False``: a failed or slow probe
    must never fail a healthy task, so callers only act on an explicit "dead".
    """
    url = (
        f"{settings.EXECUTOR_MANAGER_URL.rstrip('/')}"
        f"/executor-manager/tasks/{task_id}/heartbeat"
    )
    try:
        async with traced_async_client(timeout=3.0) as client:
            response = await client.get(url)
        if response.status_code != 200:
            logger.debug(
                "[executor_health] heartbeat probe returned %s for task %s",
                response.status_code,
                task_id,
            )
            return None
        payload = response.json()
    except Exception as exc:
        logger.warning(
            "[executor_health] heartbeat probe failed task_id=%s error=%s",
            task_id,
            exc,
        )
        add_span_event(
            "execution.executor_heartbeat_alive.check_failed",
            {"task_id": str(task_id), "error": str(exc)},
        )
        return None

    alive = payload.get("alive") if isinstance(payload, dict) else None
    return alive if isinstance(alive, bool) else None


@trace_async("execution.executor_dispatch_pending", "execution.schedule")
async def executor_dispatch_pending(task_id: int) -> Optional[bool]:
    """Return whether the task is still pending in the executor queue.

    ``None`` means the manager could not answer; callers must not turn that
    into "not queued" because a queued task would then be failed while it is
    only waiting behind backpressure.
    """
    url = (
        f"{settings.EXECUTOR_MANAGER_URL.rstrip('/')}"
        f"/executor-manager/tasks/{task_id}/dispatch-state"
    )
    try:
        async with traced_async_client(timeout=3.0) as client:
            response = await client.get(url)
        if response.status_code != 200:
            return None
        payload = response.json()
    except Exception as exc:
        logger.warning(
            "[executor_health] dispatch state probe failed task_id=%s error=%s",
            task_id,
            exc,
        )
        add_span_event(
            "execution.executor_dispatch_pending.check_failed",
            {"task_id": str(task_id), "error": str(exc)},
        )
        return None

    pending = payload.get("pending") if isinstance(payload, dict) else None
    return pending if isinstance(pending, bool) else None
