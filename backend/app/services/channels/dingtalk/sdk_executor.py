# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bounded execution for the synchronous DingTalk SDK."""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Callable, TypeVar

from app.core.bounded_executor import BoundedExecutor

T = TypeVar("T")

_DINGTALK_SDK_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=16,
    thread_name_prefix="wegent-dingtalk-sdk",
)


class DingTalkSDKTimeoutError(TimeoutError):
    """Raised when a synchronous DingTalk SDK call exceeds its await budget."""


def _run_serialized(
    operation_lock: threading.Lock,
    operation: Callable[..., T],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> T:
    with operation_lock:
        return operation(*args, **kwargs)


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()


async def run_dingtalk_sdk_operation(
    operation_lock: threading.Lock,
    operation: Callable[..., T],
    *args: Any,
    timeout_seconds: float,
    **kwargs: Any,
) -> T:
    """Run one serialized SDK call without blocking the caller's event loop.

    Timing out stops waiting, but Python cannot interrupt the synchronous SDK call.
    The worker therefore keeps the per-owner lock until that call returns, preserving
    operation order and executor capacity accounting.
    """

    operation_task = asyncio.create_task(
        _DINGTALK_SDK_EXECUTOR.run(
            _run_serialized,
            operation_lock,
            operation,
            args,
            kwargs,
        )
    )
    try:
        return await asyncio.wait_for(
            asyncio.shield(operation_task),
            timeout=timeout_seconds,
        )
    except TimeoutError as exc:
        if operation_task.done():
            return operation_task.result()
        operation_task.add_done_callback(_consume_task_exception)
        raise DingTalkSDKTimeoutError from exc
