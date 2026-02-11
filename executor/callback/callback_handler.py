#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task callback handler module.

Uses ResponsesAPIEmitter with CallbackTransport for sending events
via HTTP callback to executor_manager -> backend.

All events follow OpenAI's official Responses API specification.
"""

import asyncio
from typing import Any, Coroutine, Dict, Optional, TypeVar

from executor.callback.callback_client import CallbackClient
from shared.logger import setup_logger
from shared.models import CallbackTransport, ResponsesAPIEmitter

logger = setup_logger("task_callback_handler")

# Singleton callback client
_callback_client = CallbackClient()

T = TypeVar("T")


def _run_async(coro: Coroutine[Any, Any, T]) -> T:
    """Run an async coroutine, handling both sync and async contexts.

    If called from within a running event loop, uses nest_asyncio or
    creates a new thread to run the coroutine. Otherwise, uses
    asyncio.run() or get_event_loop().run_until_complete().

    Args:
        coro: The coroutine to run

    Returns:
        The result of the coroutine
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running event loop, safe to use run_until_complete
        loop = asyncio.get_event_loop()
        return loop.run_until_complete(coro)

    # We're inside a running event loop, need to handle this carefully
    # Use a new thread to run the coroutine
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor() as executor:
        future = executor.submit(asyncio.run, coro)
        return future.result()


def get_emitter(
    task_id: int,
    subtask_id: int,
    message_id: Optional[int] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
) -> ResponsesAPIEmitter:
    """Get a configured emitter for callback mode.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        message_id: Optional message ID
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace

    Returns:
        Configured ResponsesAPIEmitter
    """
    transport = CallbackTransport(_callback_client)
    return ResponsesAPIEmitter(
        task_id=task_id,
        subtask_id=subtask_id,
        transport=transport,
        message_id=message_id,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
    )


# ============================================================
# Async API (preferred for async contexts)
# ============================================================


async def send_start_event_async(
    task_id: int,
    subtask_id: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
    shell_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Send task start event (async version)."""
    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return await emitter.start(shell_type)


async def send_progress_event_async(
    task_id: int,
    subtask_id: int,
    progress: int,
    status: str,
    content: str = "",
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """Send progress event (async version)."""
    emitter = get_emitter(task_id, subtask_id, None, executor_name, executor_namespace)
    return await emitter.in_progress()


async def send_chunk_event_async(
    task_id: int,
    subtask_id: int,
    content: str,
    offset: int = 0,
    message_id: Optional[int] = None,
    result: Optional[Dict[str, Any]] = None,
    block_id: Optional[str] = None,
    block_offset: Optional[int] = None,
) -> Dict[str, Any]:
    """Send chunk event (async version)."""
    emitter = get_emitter(task_id, subtask_id, message_id)
    return await emitter.text_delta(content)


async def send_thinking_event_async(
    task_id: int,
    subtask_id: int,
    content: str,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Send thinking event (async version)."""
    emitter = get_emitter(task_id, subtask_id, message_id)
    return await emitter.reasoning(content)


async def send_tool_start_event_async(
    task_id: int,
    subtask_id: int,
    tool_use_id: str,
    tool_name: str,
    tool_input: Optional[dict] = None,
    message_id: Optional[int] = None,
    display_name: Optional[str] = None,
    blocks: Optional[list] = None,
) -> Dict[str, Any]:
    """Send tool start event (async version)."""
    emitter = get_emitter(task_id, subtask_id, message_id)
    return await emitter.tool_start(tool_use_id, tool_name, tool_input)


async def send_tool_result_event_async(
    task_id: int,
    subtask_id: int,
    tool_use_id: str,
    tool_name: str = "",
    tool_input: Optional[dict] = None,
    tool_output: Any = None,
    message_id: Optional[int] = None,
    error: Optional[str] = None,
    blocks: Optional[list] = None,
) -> Dict[str, Any]:
    """Send tool result event (async version)."""
    emitter = get_emitter(task_id, subtask_id, message_id)
    return await emitter.tool_done(tool_use_id, tool_name, tool_input)


async def send_done_event_async(
    task_id: int,
    subtask_id: int,
    result: Optional[Dict[str, Any]] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
    usage: Optional[Dict[str, Any]] = None,
    sources: Optional[list] = None,
    blocks: Optional[list] = None,
    stop_reason: str = "end_turn",
    silent_exit: Optional[bool] = None,
    silent_exit_reason: Optional[str] = None,
    **extra_fields,
) -> Dict[str, Any]:
    """Send done event (async version)."""
    content = ""
    if result:
        content = result.get("value", "") or ""

    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return await emitter.done(
        content=content,
        usage=usage,
        stop_reason=stop_reason,
        sources=sources,
        silent_exit=silent_exit,
        silent_exit_reason=silent_exit_reason,
        **extra_fields,
    )


async def send_error_event_async(
    task_id: int,
    subtask_id: int,
    error: str,
    error_code: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Send error event (async version)."""
    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return await emitter.error(error, error_code or "internal_error")


async def send_cancelled_event_async(
    task_id: int,
    subtask_id: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
    content: str = "",
) -> Dict[str, Any]:
    """Send cancelled event (async version)."""
    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return await emitter.incomplete(reason="cancelled", content=content)


# ============================================================
# Legacy API (for backward compatibility)
# These functions work in both sync and async contexts
# ============================================================


def send_start_event(
    task_id: int,
    subtask_id: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
    shell_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Send task start event."""
    return _run_async(
        send_start_event_async(
            task_id,
            subtask_id,
            executor_name,
            executor_namespace,
            message_id,
            shell_type,
        )
    )


def send_progress_event(
    task_id: int,
    subtask_id: int,
    progress: int,
    status: str,
    content: str = "",
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """Send progress event."""
    return _run_async(
        send_progress_event_async(
            task_id,
            subtask_id,
            progress,
            status,
            content,
            executor_name,
            executor_namespace,
        )
    )


def send_chunk_event(
    task_id: int,
    subtask_id: int,
    content: str,
    offset: int = 0,
    message_id: Optional[int] = None,
    result: Optional[Dict[str, Any]] = None,
    block_id: Optional[str] = None,
    block_offset: Optional[int] = None,
) -> Dict[str, Any]:
    """Send chunk event."""
    return _run_async(
        send_chunk_event_async(
            task_id,
            subtask_id,
            content,
            offset,
            message_id,
            result,
            block_id,
            block_offset,
        )
    )


def send_thinking_event(
    task_id: int,
    subtask_id: int,
    content: str,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Send thinking event."""
    return _run_async(
        send_thinking_event_async(task_id, subtask_id, content, message_id)
    )


def send_tool_start_event(
    task_id: int,
    subtask_id: int,
    tool_use_id: str,
    tool_name: str,
    tool_input: Optional[dict] = None,
    message_id: Optional[int] = None,
    display_name: Optional[str] = None,
    blocks: Optional[list] = None,
) -> Dict[str, Any]:
    """Send tool start event."""
    return _run_async(
        send_tool_start_event_async(
            task_id,
            subtask_id,
            tool_use_id,
            tool_name,
            tool_input,
            message_id,
            display_name,
            blocks,
        )
    )


def send_tool_result_event(
    task_id: int,
    subtask_id: int,
    tool_use_id: str,
    tool_name: str = "",
    tool_input: Optional[dict] = None,
    tool_output: Any = None,
    message_id: Optional[int] = None,
    error: Optional[str] = None,
    blocks: Optional[list] = None,
) -> Dict[str, Any]:
    """Send tool result event."""
    return _run_async(
        send_tool_result_event_async(
            task_id,
            subtask_id,
            tool_use_id,
            tool_name,
            tool_input,
            tool_output,
            message_id,
            error,
            blocks,
        )
    )


def send_done_event(
    task_id: int,
    subtask_id: int,
    result: Optional[Dict[str, Any]] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
    usage: Optional[Dict[str, Any]] = None,
    sources: Optional[list] = None,
    blocks: Optional[list] = None,
    stop_reason: str = "end_turn",
    silent_exit: Optional[bool] = None,
    silent_exit_reason: Optional[str] = None,
    **extra_fields,
) -> Dict[str, Any]:
    """Send done event."""
    return _run_async(
        send_done_event_async(
            task_id,
            subtask_id,
            result,
            executor_name,
            executor_namespace,
            message_id,
            usage,
            sources,
            blocks,
            stop_reason,
            silent_exit,
            silent_exit_reason,
            **extra_fields,
        )
    )


def send_error_event(
    task_id: int,
    subtask_id: int,
    error: str,
    error_code: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Send error event."""
    return _run_async(
        send_error_event_async(
            task_id,
            subtask_id,
            error,
            error_code,
            executor_name,
            executor_namespace,
            message_id,
        )
    )


def send_cancelled_event(
    task_id: int,
    subtask_id: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
    content: str = "",
) -> Dict[str, Any]:
    """Send cancelled event."""
    return _run_async(
        send_cancelled_event_async(
            task_id, subtask_id, executor_name, executor_namespace, message_id, content
        )
    )
