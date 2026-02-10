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

from typing import Any, Dict, Optional

from executor.callback.callback_client import CallbackClient
from shared.logger import setup_logger
from shared.models import CallbackTransport, ResponsesAPIEmitter

logger = setup_logger("task_callback_handler")

# Singleton callback client
_callback_client = CallbackClient()


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
# Legacy API (for backward compatibility)
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
    import asyncio

    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return asyncio.get_event_loop().run_until_complete(emitter.start(shell_type))


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
    import asyncio

    emitter = get_emitter(task_id, subtask_id, None, executor_name, executor_namespace)
    return asyncio.get_event_loop().run_until_complete(emitter.in_progress())


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
    import asyncio

    emitter = get_emitter(task_id, subtask_id, message_id)
    return asyncio.get_event_loop().run_until_complete(emitter.text_delta(content))


def send_thinking_event(
    task_id: int,
    subtask_id: int,
    content: str,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Send thinking event."""
    import asyncio

    emitter = get_emitter(task_id, subtask_id, message_id)
    return asyncio.get_event_loop().run_until_complete(emitter.reasoning(content))


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
    import asyncio

    emitter = get_emitter(task_id, subtask_id, message_id)
    return asyncio.get_event_loop().run_until_complete(
        emitter.tool_start(tool_use_id, tool_name, tool_input)
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
    import asyncio

    emitter = get_emitter(task_id, subtask_id, message_id)
    return asyncio.get_event_loop().run_until_complete(
        emitter.tool_done(tool_use_id, tool_name, tool_input)
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
    import asyncio

    content = ""
    if result:
        content = result.get("value", "") or ""

    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return asyncio.get_event_loop().run_until_complete(
        emitter.done(
            content=content,
            usage=usage,
            stop_reason=stop_reason,
            sources=sources,
            silent_exit=silent_exit,
            silent_exit_reason=silent_exit_reason,
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
    import asyncio

    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return asyncio.get_event_loop().run_until_complete(
        emitter.error(error, error_code or "internal_error")
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
    import asyncio

    emitter = get_emitter(
        task_id, subtask_id, message_id, executor_name, executor_namespace
    )
    return asyncio.get_event_loop().run_until_complete(
        emitter.incomplete(reason="cancelled", content=content)
    )
