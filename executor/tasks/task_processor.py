#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import os
from typing import Dict, Tuple, Optional, Any

from executor.config import config
from shared.status import TaskStatus
from shared.utils.git_util import get_domain_from_url, get_project_path_from_url

# Import the shared logger
from shared.logger import setup_logger
from executor.agents import Agent, AgentFactory
from executor.services.agent_service import AgentService
from executor.callback.callback_handler import (
    send_task_started_callback,
    send_task_completed_callback,
    send_task_failed_callback,
    send_status_callback,
)

# Use the shared logger setup function
logger = setup_logger("task_processor")


def read_task_data() -> Dict[str, Any]:
    """
    Read task data from environment variable

    Returns:
        dict: Task data

    Raises:
        SystemExit: If TASK_INFO environment variable is not set
    """
    task_data = os.getenv("TASK_INFO")
    if task_data is None:
        logger.error("TASK_INFO environment variable is not set")
        os._exit(1)
    return json.loads(task_data)


def execute_task(agent: Agent) -> Tuple[TaskStatus, Optional[str]]:
    """
    Execute task
    This function is kept for backward compatibility and is now a wrapper around AgentService.execute_agent_task

    Args:
        agent (Agent): Agent instance

    Returns:
        tuple: (status: TaskStatus, error_message: str or None)
    """
    # Get AgentService instance on demand
    agent_service = AgentService()
    return agent_service.execute_agent_task(agent)


def _get_callback_params(task_data: Dict[str, Any]) -> Dict[str, str]:
    """
    Extract common callback parameters from task data

    Args:
        task_data (dict): Task data

    Returns:
        dict: Common callback parameters
    """
    params = {
        "task_id": task_data.get("task_id", -1),
        "subtask_id": task_data.get("subtask_id", -1),
        "task_title": task_data.get("task_title", ""),
        "subtask_title": task_data.get("subtask_title", ""),
        "executor_name": os.getenv("EXECUTOR_NAME"),
        "executor_namespace": os.getenv("EXECUTOR_NAMESPACE"),
    }
    # Include task_type if present (e.g., "validation" for validation tasks)
    task_type = task_data.get("type")
    if task_type:
        params["task_type"] = task_type
    return params


def process(task_data: Dict[str, Any]) -> TaskStatus:
    """
    Process task and send callback
    Now uses AgentService to execute tasks

    Args:
        task_data (dict): Task data

    Returns:
        TaskStatus: Processing status
    """
    # Get common callback parameters
    callback_params = _get_callback_params(task_data)

    # Extract validation_id from validation_params if present (for validation tasks)
    validation_params = task_data.get("validation_params", {})
    validation_id = validation_params.get("validation_id") if validation_params else None

    # For validation tasks, include validation_id in the started callback result
    # so executor_manager can identify it as a validation task
    started_result = None
    if validation_id:
        started_result = {
            "validation_id": validation_id,
            "stage": "running",
        }

    # Send task started callback
    result = send_task_started_callback(result=started_result, **callback_params)
    if not result or result.get("status") != TaskStatus.SUCCESS.value:
        logger.error("Failed to send 'running' status callback")
        return TaskStatus.FAILED

    # Execute task using AgentService
    try:
        # Get AgentService instance on demand
        agent_service = AgentService()
        status, error_message = agent_service.execute_task(task_data)

        # Set message based on execution result
        message = (
            "Task executed successfully"
            if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]
            else error_message
        )
    except Exception as e:
        # Handle exceptions from execute_task itself
        error_msg = f"Unexpected error during task execution: {str(e)}"
        logger.exception(error_msg)
        status = TaskStatus.FAILED
        message = error_msg

    # Send task completion or failure callback
    if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]:
        send_task_completed_callback(message=message, **callback_params)
    elif status in [TaskStatus.FAILED]:
        # Include validation_id in result for validation tasks so that
        # executor_manager can forward the failure status to backend
        fail_result = None
        if validation_id:
            fail_result = {
                "validation_id": validation_id,
                "stage": "failed",
                "validation_result": {
                    "valid": False,
                    "checks": [],
                    "errors": [message] if message else [],
                },
            }
        send_task_failed_callback(error_message=message, result=fail_result, **callback_params)

    return status


def run_task() -> TaskStatus:
    """
    Main function, used to read task data and process it

    Returns:
        TaskStatus: Processing status
    """
    # Read task data
    task_data = read_task_data()

    # Process task and send callback
    return process(task_data)
