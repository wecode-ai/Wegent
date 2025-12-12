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
from shared.logger import setup_logger
from shared.telemetry.decorators import trace_sync, add_span_event, set_span_attribute
from executor.agents import Agent, AgentFactory
from executor.services.agent_service import AgentService
from executor.callback.callback_handler import (
    send_task_started_callback,
    send_task_completed_callback,
    send_task_failed_callback,
    send_status_callback,
)

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
    task_type = task_data.get("type")
    if task_type:
        params["task_type"] = task_type
    return params


def _extract_task_attributes(task_data: Dict[str, Any]) -> Dict[str, Any]:
    """Extract trace attributes from task data."""
    return {
        "task.id": str(task_data.get("task_id", -1)),
        "task.subtask_id": str(task_data.get("subtask_id", -1)),
        "task.title": task_data.get("task_title", ""),
        "task.type": task_data.get("type", "online"),
        "executor.name": os.getenv("EXECUTOR_NAME", ""),
    }


@trace_sync(
    span_name="execute_task",
    tracer_name="executor.tasks",
    extract_attributes=_extract_task_attributes
)
def process(task_data: Dict[str, Any]) -> TaskStatus:
    """
    Process task and send callback with distributed tracing support.

    Args:
        task_data (dict): Task data

    Returns:
        TaskStatus: Processing status
    """
    callback_params = _get_callback_params(task_data)

    # Extract validation_id for validation tasks
    validation_params = task_data.get("validation_params", {})
    validation_id = validation_params.get("validation_id") if validation_params else None

    started_result = None
    if validation_id:
        started_result = {"validation_id": validation_id, "stage": "running"}

    # Send task started callback
    result = send_task_started_callback(result=started_result, **callback_params)
    if not result or result.get("status") != TaskStatus.SUCCESS.value:
        logger.error("Failed to send 'running' status callback")
        set_span_attribute("error", True)
        set_span_attribute("error.message", "Failed to send running status callback")
        return TaskStatus.FAILED

    add_span_event("task_started_callback_sent")

    # Execute task using AgentService
    try:
        agent_service = AgentService()
        status, error_message = agent_service.execute_task(task_data)

        message = (
            "Task executed successfully"
            if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]
            else error_message
        )

        set_span_attribute("task.execution_status", status.value)
        if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]:
            add_span_event("task_execution_completed")
        elif status == TaskStatus.FAILED:
            set_span_attribute("error", True)
            set_span_attribute("error.message", error_message or "Unknown error")
        elif status == TaskStatus.RUNNING:
            add_span_event("task_execution_running")

    except Exception as e:
        error_msg = f"Unexpected error during task execution: {str(e)}"
        logger.exception(error_msg)
        status = TaskStatus.FAILED
        message = error_msg
        set_span_attribute("error", True)
        set_span_attribute("error.message", error_msg)

    # Send task completion or failure callback
    if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]:
        send_task_completed_callback(message=message, **callback_params)
        add_span_event("task_completed_callback_sent")
    elif status == TaskStatus.FAILED:
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
        add_span_event("task_failed_callback_sent")

    return status


def run_task() -> TaskStatus:
    """
    Main function, used to read task data and process it

    Returns:
        TaskStatus: Processing status
    """
    task_data = read_task_data()
    return process(task_data)
