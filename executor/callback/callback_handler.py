#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task callback handler module, responsible for handling task callbacks
"""

import logging
from typing import Dict, Any, Optional

from executor.callback.callback_client import CallbackClient
from shared.status import TaskStatus
from shared.logger import setup_logger

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
) -> Dict[str, Any]:
    """
    Send status callback

    Args:
        task_id (str): Task ID
        task_title (str): Task title
        status (str): Status
        message (str): Message
        progress (int): Progress
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace

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
) -> Dict[str, Any]:
    """
    Send task started callback

    Args:
        task_id (str): Task ID
        task_title (str): Task title
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace

    Returns:
        Dict[str, Any]: Callback response
    """
    return send_status_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        task_title=task_title,
        subtask_title=subtask_title,
        status=TaskStatus.RUNNING.value,
        message="Task execution started",
        progress=50,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
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
) -> Dict[str, Any]:
    """
    Send task completed callback

    Args:
        task_id (str): Task ID
        subtask_id (int): Subtask ID
        task_title (str): Task title
        subtask_title (str, optional): Subtask title
        message (str, optional): Message. Defaults to "Task executed successfully".
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace
        result (dict, optional): Result data to include in callback

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
    )


def send_task_failed_callback(
    task_id: int,
    subtask_id: int,
    task_title: str,
    subtask_title: Optional[str] = None,
    error_message: Optional[str] = None,
    executor_name: Optional[str] = None,
    executor_namespace: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send task failed callback

    Args:
        task_id (str): Task ID
        task_title (str): Task title
        error_message (str): Error message
        executor_name (str, optional): Executor name
        executor_namespace (str, optional): Executor namespace

    Returns:
        Dict[str, Any]: Callback response
    """
    return send_status_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        task_title=task_title,
        subtask_title=subtask_title,
        status=TaskStatus.FAILED.value,
        message=error_message,
        progress=100,
        executor_name=executor_name,
        executor_namespace=executor_namespace,
    )