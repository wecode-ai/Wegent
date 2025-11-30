#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
API routes module, defines FastAPI routes and models
"""

import os
import time
from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from shared.logger import setup_logger
from executor_manager.tasks.task_processor import TaskProcessor
from executor_manager.clients.task_api_client import TaskApiClient
from shared.models.task import TasksRequest
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.services.restart_limiter import get_restart_limiter
from executor_manager.executors.docker.utils import delete_container
from typing import Optional, Dict, Any, List

# Setup logger
logger = setup_logger(__name__)

# Create FastAPI app
app = FastAPI(
    title="Executor Manager API",
    description="API for managing executor tasks and callbacks",
)

# Create task processor for handling callbacks
task_processor = TaskProcessor()
# Create API client for direct API calls
api_client = TaskApiClient()

@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Middleware: Log request duration and source IP"""
    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"
    
    # Process request
    response = await call_next(request)
    
    # Calculate duration in milliseconds
    process_time_ms = (time.time() - start_time) * 1000
    
    # Only log request completion with duration and IP for monitoring purposes
    # Avoid duplicate logging since FastAPI already logs basic request info
    logger.info(f"Request: {request.method} {request.url.path} from {client_ip} - "
                f"Status: {response.status_code} - Time: {process_time_ms:.0f}ms")
    
    return response


# Define callback request model
class CallbackRequest(BaseModel):
    task_id: int
    subtask_id: int
    task_title: Optional[str] = None
    progress: int
    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None
    status: Optional[str] = None
    error_message: Optional[str] = None
    result: Optional[Dict[str, Any]] = None


@app.post("/executor-manager/callback")
async def callback_handler(request: CallbackRequest, http_request: Request):
    """
    Receive callback interface for executor task progress and completion.

    Args:
        request: Request body containing task ID, pod name, and progress.

    Returns:
        dict: Processing result
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(f"Received callback: body={request} from {client_ip}")
        # Directly call the API client to update task status
        success, result = api_client.update_task_status_by_fields(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            progress=request.progress,
            executor_name=request.executor_name,
            executor_namespace=request.executor_namespace,
            status=request.status,
            error_message=request.error_message,
            title=request.task_title,
            result=request.result,
        )
        if not success:
            logger.warning(f"Failed to update status for task {request.task_id}: {result}")

        # Clear restart count when task reaches final state
        final_states = ["COMPLETED", "FAILED", "CANCELLED"]
        if request.status and request.status.upper() in final_states:
            try:
                restart_limiter = get_restart_limiter()
                restart_limiter.clear_restart_count(request.subtask_id)
                logger.info(f"Cleared restart count for subtask {request.subtask_id} (status: {request.status})")
            except Exception as e:
                logger.warning(f"Failed to clear restart count for subtask {request.subtask_id}: {e}")

        logger.info(f"Successfully processed callback for task {request.task_id}")
        return {
            "status": "success",
            "message": f"Successfully processed callback for task {request.task_id}",
        }
    except Exception as e:
        logger.error(f"Error processing callback: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/executor-manager/tasks/receive")
async def receive_tasks(request: TasksRequest, http_request: Request):
    """
    Receive tasks in batch via POST.
    Args:
        request: TasksRequest containing a list of tasks.
    Returns:
        dict: result code
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(
            f"Received {len(request.tasks)} tasks, first task: {request.tasks[0].task_title if request.tasks else 'None'} from {client_ip}"
        )
        # Call the task processor to handle the tasks
        task_processor.process_tasks([task.dict() for task in request.tasks])
        return {"code": 0}
    except Exception as e:
        logger.error(f"Error processing tasks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy"}


class DeleteExecutorRequest(BaseModel):
    executor_name: str


@app.post("/executor-manager/executor/delete")
async def delete_executor(request: DeleteExecutorRequest, http_request: Request):
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(f"Received request to delete executor: {request.executor_name} from {client_ip}")
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        result = executor.delete_executor(request.executor_name)
        return result
    except Exception as e:
        logger.error(f"Error deleting executor '{request.executor_name}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/executor-manager/executor/load")
async def get_executor_load(http_request: Request):
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(f"Received request to get executor load from {client_ip}")
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        result = executor.get_executor_count()
        result["total"] = int(os.getenv("MAX_CONCURRENT_TASKS", "30"))
        return result
    except Exception as e:
        logger.error(f"Error getting executor load: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class CancelTaskRequest(BaseModel):
    task_id: int


@app.post("/executor-manager/tasks/cancel")
async def cancel_task(request: CancelTaskRequest, http_request: Request):
    """
    Cancel a running task by calling the executor's cancel API.

    Args:
        request: Request containing task_id to cancel

    Returns:
        dict: Cancellation result
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(f"Received request to cancel task {request.task_id} from {client_ip}")

        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        result = executor.cancel_task(request.task_id)

        if result["status"] == "success":
            logger.info(f"Successfully cancelled task {request.task_id}")
            return result
        else:
            logger.warning(f"Failed to cancel task {request.task_id}: {result.get('error_msg', 'Unknown error')}")
            raise HTTPException(status_code=400, detail=result.get("error_msg", "Failed to cancel task"))

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling task {request.task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ExecutorStartupRequest(BaseModel):
    """Request model for executor startup notification"""
    subtask_id: int
    task_id: int
    executor_name: str


class ExecutorStartupResponse(BaseModel):
    """Response model for executor startup check"""
    allowed: bool
    restart_count: int
    max_restart: int
    message: str = ""


@app.post("/executor-manager/executor/startup", response_model=ExecutorStartupResponse)
async def executor_startup(request: ExecutorStartupRequest, http_request: Request):
    """
    Executor startup notification endpoint.

    Called by executor containers at startup to check if restart is allowed.
    Increments the restart counter and returns whether execution should proceed.

    Args:
        request: ExecutorStartupRequest containing subtask_id, task_id, executor_name

    Returns:
        ExecutorStartupResponse: Contains allowed status, restart count, and max limit
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"Received executor startup notification: subtask_id={request.subtask_id}, "
        f"task_id={request.task_id}, executor_name={request.executor_name} from {client_ip}"
    )

    try:
        restart_limiter = get_restart_limiter()
        check_result = restart_limiter.check_and_increment(request.subtask_id)

        if check_result.allowed:
            logger.info(
                f"Executor startup allowed for subtask {request.subtask_id}: "
                f"count={check_result.restart_count}/{check_result.max_restart}"
            )
            return ExecutorStartupResponse(
                allowed=True,
                restart_count=check_result.restart_count,
                max_restart=check_result.max_restart,
                message=check_result.message
            )
        else:
            # Restart limit exceeded - mark task as failed and clean up
            logger.warning(
                f"Executor restart limit exceeded for subtask {request.subtask_id}: "
                f"count={check_result.restart_count}/{check_result.max_restart}"
            )

            # Mark subtask as failed via backend API
            error_message = f"Executor restart limit exceeded (max: {check_result.max_restart} times)"
            try:
                success, result = api_client.update_task_status_by_fields(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    progress=100,
                    executor_name=request.executor_name,
                    status="FAILED",
                    error_message=error_message,
                )
                if success:
                    logger.info(f"Marked subtask {request.subtask_id} as FAILED due to restart limit")
                else:
                    logger.warning(f"Failed to mark subtask {request.subtask_id} as FAILED: {result}")
            except Exception as e:
                logger.error(f"Error updating task status for subtask {request.subtask_id}: {e}")

            # Delete the executor container
            try:
                delete_result = delete_container(request.executor_name)
                if delete_result.get("status") == "success":
                    logger.info(f"Deleted executor container {request.executor_name}")
                else:
                    logger.warning(
                        f"Failed to delete executor container {request.executor_name}: "
                        f"{delete_result.get('error_msg', 'Unknown error')}"
                    )
            except Exception as e:
                logger.error(f"Error deleting executor container {request.executor_name}: {e}")

            # Clear the restart count since we're failing the task
            try:
                restart_limiter.clear_restart_count(request.subtask_id)
            except Exception as e:
                logger.warning(f"Failed to clear restart count for subtask {request.subtask_id}: {e}")

            return ExecutorStartupResponse(
                allowed=False,
                restart_count=check_result.restart_count,
                max_restart=check_result.max_restart,
                message=error_message
            )

    except Exception as e:
        logger.error(f"Error processing executor startup: {e}")
        # Fail-open: allow execution if there's an error checking restart count
        return ExecutorStartupResponse(
            allowed=True,
            restart_count=0,
            max_restart=3,
            message=f"Error checking restart limit, allowing execution: {str(e)}"
        )
