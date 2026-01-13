#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task callback handler module, responsible for handling task callbacks.

Provides convenience functions for both full result callbacks and incremental chunk callbacks.
"""

from typing import Any, Dict, Optional

from executor.callback.callback_client import CallbackClient
from shared.logger import setup_logger
from shared.status import TaskStatus

# Use the shared logger setup function
logger = setup_logger("task_callback_handler")

# Create a singleton callback client instance
callback_client = CallbackClient()


def send_status_callback(
    task_id: int,
    subtask_id: int,
    task_title: str,
    subtask_title: str,
    status: str,
    message: str,
    progress: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send status callback.

    Args:
        task_id (str): Task ID
        subtask_id (int): Subtask ID
        task_title (str): Task title
        subtask_title (str): Subtask title
        status (str): Status
        message (str): Message
        progress (int): Progress
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace
        task_type (str, optional): Task type (e.g., "validation" for validation tasks)

    Returns:
        Dict[str, Any]: Callback response
    """
    try:
        result = callback_client.send_callback(
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_title,
            subtask_title=subtask_title,
            progress=progress,
            status=status,
            message=message,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
            task_type=task_type,
        )

        if result and result.get("status") == TaskStatus.SUCCESS.value:
            logger.info(f"Sent task '{status}' status callback successfully")
        else:
            logger.error(
                f"Failed to send '{status}' status callback: {result.get('error_msg')}"
            )

        return result
    except Exception as e:
        error_msg = f"Failed to send '{status}' status callback: {e}"
        logger.exception(error_msg)
        return {"status": TaskStatus.FAILED.value, "error_msg": error_msg}


def send_task_started_callback(
    task_id: int,
    subtask_id: int,
    task_title: str,
    subtask_title: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send task started callback.

    Args:
        task_id (str): Task ID
        subtask_id (int): Subtask ID
        task_title (str): Task title
        subtask_title (str, optional): Subtask title
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace
        result (dict, optional): Result data to include in callback (e.g., validation_id)
        task_type (str, optional): Task type (e.g., "validation" for validation tasks)

    Returns:
        Dict[str, Any]: Callback response
    """
    return callback_client.send_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        task_title=task_title,
        subtask_title=subtask_title,
        status=TaskStatus.RUNNING.value,
        message="Task execution started",
        progress=50,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        result=result,
        task_type=task_type,
    )


def send_task_completed_callback(
    task_id: int,
    subtask_id: int,
    task_title: str,
    subtask_title: Optional[str] = None,
    message: str = "Task executed successfully",
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send task completed callback.

    Args:
        task_id (str): Task ID
        subtask_id (int): Subtask ID
        task_title (str): Task title
        subtask_title (str, optional): Subtask title
        message (str, optional): Message. Defaults to "Task executed successfully".
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace
        result (dict, optional): Result data to include in callback
        task_type (str, optional): Task type (e.g., "validation" for validation tasks)

    Returns:
        Dict[str, Any]: Callback response
    """
    return callback_client.send_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        task_title=task_title,
        subtask_title=subtask_title,
        status=TaskStatus.COMPLETED.value,
        message=message,
        progress=100,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        result=result,
        task_type=task_type,
    )


def send_task_failed_callback(
    task_id: int,
    subtask_id: int,
    task_title: str,
    subtask_title: Optional[str] = None,
    error_message: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send task failed callback.

    Args:
        task_id (str): Task ID
        subtask_id (int): Subtask ID
        task_title (str): Task title
        subtask_title (str, optional): Subtask title
        error_message (str): Error message
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace
        result (dict, optional): Result data to include in callback (e.g., validation_id)
        task_type (str, optional): Task type (e.g., "validation" for validation tasks)

    Returns:
        Dict[str, Any]: Callback response
    """
    return callback_client.send_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        task_title=task_title,
        subtask_title=subtask_title,
        status=TaskStatus.FAILED.value,
        message=error_message,
        progress=100,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        result=result,
        task_type=task_type,
    )


# ============================================================
# Incremental Chunk Callback Functions
# ============================================================


def send_content_chunk_callback(
    task_id: int,
    subtask_id: int,
    content: str,
    offset: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send incremental content chunk callback.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        content: Incremental text content
        offset: Current character offset position
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        task_type: Optional task type

    Returns:
        Dict[str, Any]: Callback response
    """
    data = {
        "content": content,
        "offset": offset,
    }
    return callback_client.send_chunk_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        chunk_type="chunk",
        data=data,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        task_type=task_type,
    )


def send_thinking_chunk_callback(
    task_id: int,
    subtask_id: int,
    step: Dict[str, Any],
    step_index: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send thinking step chunk callback.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        step: Thinking step data dict with title, status, tool_name, details, run_id
        step_index: Step index for update/append
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        task_type: Optional task type

    Returns:
        Dict[str, Any]: Callback response
    """
    data = {
        "step": step,
        "step_index": step_index,
    }
    return callback_client.send_chunk_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        chunk_type="thinking",
        data=data,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        task_type=task_type,
    )


def send_reasoning_chunk_callback(
    task_id: int,
    subtask_id: int,
    content: str,
    offset: int,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send reasoning content chunk callback (DeepSeek R1).

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        content: Incremental reasoning content
        offset: Current character offset
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        task_type: Optional task type

    Returns:
        Dict[str, Any]: Callback response
    """
    data = {
        "content": content,
        "offset": offset,
    }
    return callback_client.send_chunk_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        chunk_type="reasoning",
        data=data,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        task_type=task_type,
    )


def send_workbench_delta_callback(
    task_id: int,
    subtask_id: int,
    delta: Dict[str, Any],
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send workbench delta chunk callback.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        delta: Delta/patch data dict containing file_changes, git_info, status, error
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        task_type: Optional task type

    Returns:
        Dict[str, Any]: Callback response
    """
    data = {
        "delta": delta,
    }
    return callback_client.send_chunk_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        chunk_type="workbench_delta",
        data=data,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        task_type=task_type,
    )


def send_status_chunk_callback(
    task_id: int,
    subtask_id: int,
    status: str,
    progress: int = 0,
    error_message: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
    task_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send status update chunk callback.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        status: Status string (RUNNING, COMPLETED, FAILED)
        progress: Progress percentage (0-100)
        error_message: Optional error message
        executor_name: Optional executor name
        executor_namespace: Optional executor namespace
        task_type: Optional task type

    Returns:
        Dict[str, Any]: Callback response
    """
    data = {
        "status": status,
        "progress": progress,
    }
    if error_message:
        data["error_message"] = error_message

    return callback_client.send_chunk_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        chunk_type="status",
        data=data,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
        task_type=task_type,
    )


def is_incremental_callback_enabled() -> bool:
    """Check if incremental callbacks are enabled.

    Returns:
        bool: True if incremental callbacks are enabled
    """
    return callback_client.incremental_enabled