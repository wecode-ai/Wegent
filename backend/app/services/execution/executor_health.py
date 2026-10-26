# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor liveness checks shared by every dispatch path."""

import asyncio
import logging

from shared.telemetry.decorators import add_span_event, trace_async

logger = logging.getLogger(__name__)


@trace_async("execution.executor_pod_missing", "execution.schedule")
async def executor_pod_missing(
    executor_name: str,
    executor_namespace: str | None,
) -> bool:
    """Return True only when executor_manager confirms the executor is gone.

    Wraps ``remote_workspace_service.executor_alive`` in a thread because the
    underlying httpx call is synchronous. Any transport/decoding failure is
    treated as "pod still alive" so dispatch surfaces the real error instead
    of triggering a spurious recovery.
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
