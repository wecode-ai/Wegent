#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import os
from typing import Any, Dict, Optional, Tuple, Union

from executor.agents import Agent, AgentFactory
from executor.callback.callback_handler import (
    send_done_event,
    send_done_event_async,
    send_error_event,
    send_error_event_async,
    send_start_event,
    send_start_event_async,
)
from executor.config import config
from executor.services.agent_service import AgentService
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.models.openai_converter import get_metadata_field
from shared.status import TaskStatus
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_async,
    trace_sync,
)

logger = setup_logger("task_processor")


def read_task_data() -> Dict[str, Any]:
    """
    Read task data from environment variable or file.

    Returns:
        dict: Task data

    Raises:
        SystemExit: If TASK_INFO is not found
    """
    from executor.config.env_reader import get_task_info

    task_data = get_task_info()
    if task_data is None:
        logger.error("TASK_INFO not found")
        os._exit(1)
    return task_data


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


def _get_callback_params(
    request: Union[ExecutionRequest, Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Extract common callback parameters from execution request or task data.

    Supports ExecutionRequest, OpenAI format dict, and legacy dict.

    Args:
        request: ExecutionRequest object or task data dict

    Returns:
        dict: Common callback parameters
    """
    if isinstance(request, ExecutionRequest):
        return {
            "task_id": request.task_id,
            "subtask_id": request.subtask_id,
            "executor_name": os.getenv("EXECUTOR_NAME"),
            "executor_namespace": os.getenv("EXECUTOR_NAMESPACE"),
        }
    else:
        return {
            "task_id": get_metadata_field(request, "task_id", -1),
            "subtask_id": get_metadata_field(request, "subtask_id", -1),
            "executor_name": os.getenv("EXECUTOR_NAME"),
            "executor_namespace": os.getenv("EXECUTOR_NAMESPACE"),
        }


def _extract_task_attributes(
    request: Union[ExecutionRequest, Dict[str, Any]],
) -> Dict[str, Any]:
    """Extract trace attributes from execution request or task data."""
    if isinstance(request, ExecutionRequest):
        attrs = {
            "task.id": str(request.task_id),
            "task.subtask_id": str(request.subtask_id),
            "task.title": request.task_title or "",
            "task.type": request.type or "online",
            "executor.name": os.getenv("EXECUTOR_NAME", ""),
        }
        # Extract user info if available
        user_data = request.user
        if user_data:
            if user_data.get("id"):
                attrs["user.id"] = str(user_data.get("id"))
            if user_data.get("name"):
                attrs["user.name"] = user_data.get("name")
    else:
        attrs = {
            "task.id": str(get_metadata_field(request, "task_id", -1)),
            "task.subtask_id": str(get_metadata_field(request, "subtask_id", -1)),
            "task.title": get_metadata_field(request, "task_title", ""),
            "task.type": get_metadata_field(request, "type", "online"),
            "executor.name": os.getenv("EXECUTOR_NAME", ""),
        }
        # Extract user info if available
        user_data = get_metadata_field(request, "user", {})
        if user_data:
            if user_data.get("id"):
                attrs["user.id"] = str(user_data.get("id"))
            if user_data.get("name"):
                attrs["user.name"] = user_data.get("name")
    return attrs


def _normalize_request(
    request: Union[ExecutionRequest, Dict[str, Any]],
) -> ExecutionRequest:
    """
    Normalize input to ExecutionRequest.

    Supports:
    - ExecutionRequest objects (returned as-is)
    - OpenAI Responses API format dicts (detected by "model" + "metadata" keys)
    - Legacy ExecutionRequest dict format

    Args:
        request: ExecutionRequest object or task data dict

    Returns:
        ExecutionRequest: Normalized request object
    """
    if isinstance(request, ExecutionRequest):
        return request
    # Detect OpenAI format by checking for "model" + "metadata" keys
    if isinstance(request, dict) and "model" in request and "metadata" in request:
        from shared.models import OpenAIRequestConverter

        return OpenAIRequestConverter.to_execution_request(request)
    return ExecutionRequest.from_dict(request)


@trace_sync(
    span_name="execute_task",
    tracer_name="executor.tasks",
    extract_attributes=_extract_task_attributes,
)
def process(request: Union[ExecutionRequest, Dict[str, Any]]) -> TaskStatus:
    """
    Process task and send callback with distributed tracing support.

    For subscription tasks, the container will exit after task completion
    (success or failure) since subscription tasks are one-time background
    executions that don't need to keep the container running.

    Args:
        request: ExecutionRequest object or task data dict (for backward compatibility)

    Returns:
        TaskStatus: Processing status
    """
    # Normalize to ExecutionRequest for type safety
    exec_request = _normalize_request(request)

    # Convert to dict for AgentService (which still uses dict internally)
    task_data = exec_request.to_dict()

    callback_params = _get_callback_params(exec_request)

    # Check if this is a subscription task
    is_subscription = exec_request.is_subscription

    # Extract validation_id for validation tasks
    # Note: validation_params is not in ExecutionRequest, check task_data for backward compatibility
    validation_params = task_data.get("validation_params", {})
    validation_id = (
        validation_params.get("validation_id") if validation_params else None
    )

    started_result = None
    if validation_id:
        started_result = {"validation_id": validation_id, "stage": "running"}

    # Send task started event using unified ExecutionEvent format
    result = send_start_event(**callback_params)
    if not result or result.get("status") != TaskStatus.SUCCESS.value:
        logger.error("Failed to send 'start' event")
        set_span_attribute("error", True)
        set_span_attribute("error.message", "Failed to send start event")
        # For subscription tasks, exit container on failure
        if is_subscription:
            logger.info(
                "Subscription task failed to start, exiting container with code 1"
            )
            os._exit(1)
        return TaskStatus.FAILED

    add_span_event("task_started_event_sent")

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

    # Send task completion or failure event using unified ExecutionEvent format
    if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]:
        done_result = None
        if validation_id:
            done_result = {"validation_id": validation_id, "stage": "completed"}
            # Try to retrieve detailed validation results from the agent
            try:
                agent = agent_service.get_agent(f"{exec_request.task_id}")
                if agent and hasattr(agent, "validation_result"):
                    import json

                    done_result["value"] = json.dumps(agent.validation_result)
            except Exception as e:
                logger.warning(f"Failed to retrieve validation result: {e}")
        send_done_event(result=done_result, **callback_params)
        add_span_event("task_done_event_sent")
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
        send_error_event(
            error=message or "Unknown error",
            **callback_params,
        )
        add_span_event("task_error_event_sent")

    # For subscription tasks, exit container after completion
    # Subscription tasks are one-time background executions that don't need
    # to keep the container running for follow-up messages
    if is_subscription and status in [
        TaskStatus.SUCCESS,
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
    ]:
        exit_code = 0 if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED] else 1
        logger.info(
            f"Subscription task completed with status {status.value}, "
            f"exiting container with code {exit_code}"
        )
        os._exit(exit_code)

    return status


@trace_async(
    span_name="execute_task",
    tracer_name="executor.tasks",
    extract_attributes=_extract_task_attributes,
)
async def process_async(request: Union[ExecutionRequest, Dict[str, Any]]) -> TaskStatus:
    """
    Process task and send callback with distributed tracing support (async version).

    This is the async version of process() that should be used when called from
    an async context (e.g., FastAPI lifespan).

    For subscription tasks, the container will exit after task completion
    (success or failure) since subscription tasks are one-time background
    executions that don't need to keep the container running.

    Args:
        request: ExecutionRequest object or task data dict (for backward compatibility)

    Returns:
        TaskStatus: Processing status
    """
    # Normalize to ExecutionRequest for type safety
    exec_request = _normalize_request(request)

    # Convert to dict for AgentService (which still uses dict internally)
    task_data = exec_request.to_dict()

    callback_params = _get_callback_params(exec_request)

    # Check if this is a subscription task
    is_subscription = exec_request.is_subscription

    # Extract validation_id for validation tasks
    # Note: validation_params is not in ExecutionRequest, check task_data for backward compatibility
    validation_params = task_data.get("validation_params", {})
    validation_id = (
        validation_params.get("validation_id") if validation_params else None
    )

    started_result = None
    if validation_id:
        started_result = {"validation_id": validation_id, "stage": "running"}

    # Send task started event using unified ExecutionEvent format (async)
    result = await send_start_event_async(**callback_params)
    if not result or result.get("status") != TaskStatus.SUCCESS.value:
        logger.error("Failed to send 'start' event")
        set_span_attribute("error", True)
        set_span_attribute("error.message", "Failed to send start event")
        # For subscription tasks, exit container on failure
        if is_subscription:
            logger.info(
                "Subscription task failed to start, exiting container with code 1"
            )
            os._exit(1)
        return TaskStatus.FAILED

    add_span_event("task_started_event_sent")

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

    # Send task completion or failure event using unified ExecutionEvent format (async)
    if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED]:
        done_result = None
        if validation_id:
            done_result = {"validation_id": validation_id, "stage": "completed"}
            # Try to retrieve detailed validation results from the agent
            try:
                agent = agent_service.get_agent(f"{exec_request.task_id}")
                if agent and hasattr(agent, "validation_result"):
                    import json

                    done_result["value"] = json.dumps(agent.validation_result)
            except Exception as e:
                logger.warning(f"Failed to retrieve validation result: {e}")
        await send_done_event_async(result=done_result, **callback_params)
        add_span_event("task_done_event_sent")
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
        await send_error_event_async(
            error=message or "Unknown error",
            **callback_params,
        )
        add_span_event("task_error_event_sent")

    # For subscription tasks, exit container after completion
    # Subscription tasks are one-time background executions that don't need
    # to keep the container running for follow-up messages
    if is_subscription and status in [
        TaskStatus.SUCCESS,
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
    ]:
        exit_code = 0 if status in [TaskStatus.SUCCESS, TaskStatus.COMPLETED] else 1
        logger.info(
            f"Subscription task completed with status {status.value}, "
            f"exiting container with code {exit_code}"
        )
        os._exit(exit_code)

    return status


def run_task() -> TaskStatus:
    """
    Main function, used to read task data and process it

    Returns:
        TaskStatus: Processing status
    """
    task_data = read_task_data()
    return process(task_data)


async def run_task_async() -> TaskStatus:
    """
    Main function (async version), used to read task data and process it.

    This is the async version of run_task() that should be used when called from
    an async context (e.g., FastAPI lifespan).

    Returns:
        TaskStatus: Processing status
    """
    task_data = read_task_data()
    return await process_async(task_data)
