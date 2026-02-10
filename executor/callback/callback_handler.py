#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task callback handler module, responsible for handling task callbacks.

Uses unified ExecutionEvent format from shared.models.execution.
All legacy callback functions have been removed - use ExecutionEvent-based functions only.
"""

from typing import Any, Dict, Optional

from executor.callback.callback_client import CallbackClient
from shared.logger import setup_logger
from shared.models.execution import EventType, ExecutionEvent
from shared.status import TaskStatus

# Use the shared logger setup function
logger = setup_logger("task_callback_handler")

# Create a singleton callback client instance
callback_client = CallbackClient()


def send_execution_event(event: ExecutionEvent) -> Dict[str, Any]:
    """
    Send an ExecutionEvent directly using the unified format.

    This is the primary method for sending events.

    Args:
        event: ExecutionEvent to send

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        result = callback_client.send_event(event)

        if result and result.get("status") == TaskStatus.SUCCESS.value:
            logger.info(f"Sent execution event '{event.type}' successfully")
        else:
            logger.error(
                f"Failed to send execution event '{event.type}': {result.get('error_msg')}"
            )

        return result
    except Exception as e:
        error_msg = f"Failed to send execution event '{event.type}': {e}"
        logger.exception(error_msg)
        return {"status": TaskStatus.FAILED.value, "error_msg": error_msg}


def send_start_event(
    task_id: int,
    subtask_id: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Send task start event using unified ExecutionEvent format.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        message_id: Optional message ID

    Returns:
        Dict[str, Any]: Callback response
    """
    event = ExecutionEvent.create(
        event_type=EventType.START,
        task_id=task_id,
        subtask_id=subtask_id,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        message_id=message_id,
        status=TaskStatus.RUNNING.value,
    )
    return send_execution_event(event)


def send_progress_event(
    task_id: int,
    subtask_id: int,
    progress: int,
    status: str,
    content: str = "",
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send progress event using unified ExecutionEvent format.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        progress: Progress percentage (0-100)
        status: Status string
        content: Optional content/message
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace

    Returns:
        Dict[str, Any]: Callback response
    """
    event = ExecutionEvent.create(
        event_type=EventType.PROGRESS,
        task_id=task_id,
        subtask_id=subtask_id,
        progress=progress,
        status=status,
        content=content,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
    )
    return send_execution_event(event)


def send_chunk_event(
    task_id: int,
    subtask_id: int,
    content: str,
    offset: int = 0,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Send chunk event for streaming content using unified ExecutionEvent format.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        content: Chunk content
        offset: Content offset
        message_id: Optional message ID

    Returns:
        Dict[str, Any]: Callback response
    """
    event = ExecutionEvent.create(
        event_type=EventType.CHUNK,
        task_id=task_id,
        subtask_id=subtask_id,
        content=content,
        offset=offset,
        message_id=message_id,
    )
    return send_execution_event(event)


def send_done_event(
    task_id: int,
    subtask_id: int,
    result: Optional[Dict[str, Any]] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Send done event using unified ExecutionEvent format.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        result: Optional result data
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        message_id: Optional message ID

    Returns:
        Dict[str, Any]: Callback response
    """
    event = ExecutionEvent.create(
        event_type=EventType.DONE,
        task_id=task_id,
        subtask_id=subtask_id,
        result=result,
        status=TaskStatus.COMPLETED.value,
        progress=100,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        message_id=message_id,
    )
    return send_execution_event(event)


def send_error_event(
    task_id: int,
    subtask_id: int,
    error: str,
    error_code: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Send error event using unified ExecutionEvent format.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        error: Error message
        error_code: Optional error code
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        message_id: Optional message ID

    Returns:
        Dict[str, Any]: Callback response
    """
    event = ExecutionEvent.create(
        event_type=EventType.ERROR,
        task_id=task_id,
        subtask_id=subtask_id,
        error=error,
        error_code=error_code,
        status=TaskStatus.FAILED.value,
        progress=100,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        message_id=message_id,
    )
    return send_execution_event(event)


def send_cancelled_event(
    task_id: int,
    subtask_id: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    message_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Send cancelled event using unified ExecutionEvent format.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        message_id: Optional message ID

    Returns:
        Dict[str, Any]: Callback response
    """
    event = ExecutionEvent.create(
        event_type=EventType.CANCELLED,
        task_id=task_id,
        subtask_id=subtask_id,
        status=TaskStatus.CANCELLED.value,
        progress=100,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        message_id=message_id,
    )
    return send_execution_event(event)
