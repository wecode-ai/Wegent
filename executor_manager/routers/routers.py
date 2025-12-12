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
import uuid
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.tasks.task_processor import TaskProcessor
from shared.logger import setup_logger
from shared.models.task import TasksRequest
from shared.telemetry.config import get_otel_config

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

# Health check paths that should skip logging to reduce overhead
HEALTH_CHECK_PATHS = {"/", "/health"}


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Middleware: Log request duration, source IP, and capture OTEL data"""
    from starlette.responses import StreamingResponse

    # Skip logging for health check requests
    if request.url.path == "/health":
        return await call_next(request)

    # Generate a unique request ID
    request_id = str(uuid.uuid4())[:8]
    request.state.request_id = request_id

    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"

    # Get OTEL config
    otel_config = get_otel_config()

    # Capture request body if OTEL is enabled and body capture is configured
    request_body = None
    if (
        otel_config.enabled
        and otel_config.capture_request_body
        and request.method in ("POST", "PUT", "PATCH")
    ):
        try:
            body_bytes = await request.body()
            if body_bytes:
                max_body_size = 4096
                if len(body_bytes) <= max_body_size:
                    request_body = body_bytes.decode("utf-8", errors="replace")
                else:
                    request_body = (
                        body_bytes[:max_body_size].decode("utf-8", errors="replace")
                        + f"... [truncated, total size: {len(body_bytes)} bytes]"
                    )
        except Exception as e:
            logger.debug(f"Failed to capture request body: {e}")

    # Add OpenTelemetry span attributes if enabled
    if otel_config.enabled:
        try:
            from opentelemetry import trace

            from shared.telemetry.context import set_request_context
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                set_request_context(request_id)

                if request_body:
                    current_span = trace.get_current_span()
                    if current_span and current_span.is_recording():
                        current_span.set_attribute("http.request.body", request_body)
        except Exception as e:
            logger.debug(f"Failed to set OTEL context: {e}")

    # Pre-request logging
    logger.info(
        f"request : {request.method} {request.url.path} {request.query_params} {request_id} {client_ip}"
    )

    # Process request
    response = await call_next(request)

    # Calculate duration in milliseconds
    process_time_ms = (time.time() - start_time) * 1000

    # Capture response headers and body if OTEL is enabled
    if otel_config.enabled:
        try:
            from opentelemetry import trace

            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                current_span = trace.get_current_span()
                if current_span and current_span.is_recording():
                    # Capture response headers
                    if otel_config.capture_response_headers:
                        for header_name, header_value in response.headers.items():
                            if header_name.lower() in (
                                "authorization",
                                "cookie",
                                "set-cookie",
                            ):
                                header_value = "[REDACTED]"
                            current_span.set_attribute(
                                f"http.response.header.{header_name}", header_value
                            )

                    # Capture response body (only for non-streaming responses)
                    if otel_config.capture_response_body:
                        if not isinstance(response, StreamingResponse):
                            try:
                                response_body_chunks = []
                                async for chunk in response.body_iterator:
                                    response_body_chunks.append(chunk)

                                response_body = b"".join(response_body_chunks)

                                max_body_size = 4096
                                if response_body:
                                    if len(response_body) <= max_body_size:
                                        body_str = response_body.decode(
                                            "utf-8", errors="replace"
                                        )
                                    else:
                                        body_str = (
                                            response_body[:max_body_size].decode(
                                                "utf-8", errors="replace"
                                            )
                                            + f"... [truncated, total size: {len(response_body)} bytes]"
                                        )
                                    current_span.set_attribute(
                                        "http.response.body", body_str
                                    )

                                from starlette.responses import Response

                                response = Response(
                                    content=response_body,
                                    status_code=response.status_code,
                                    headers=dict(response.headers),
                                    media_type=response.media_type,
                                )
                            except Exception as e:
                                logger.debug(f"Failed to capture response body: {e}")
        except Exception as e:
            logger.debug(f"Failed to capture OTEL response: {e}")

    # Post-request logging
    logger.info(
        f"response: {request.method} {request.url.path} {request_id} {client_ip} "
        f"{response.status_code} {process_time_ms:.0f}ms"
    )

    response.headers["X-Request-ID"] = request_id
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
    task_type: Optional[str] = (
        None  # Task type: "validation" for validation tasks, None for regular tasks
    )


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

        # Check if this is a validation task callback
        # Primary check: task_type == "validation"
        # Fallback check: validation_id in result (for backward compatibility)
        is_validation_task = request.task_type == "validation" or (
            request.result and request.result.get("validation_id")
        )
        if is_validation_task:
            await _forward_validation_callback(request)
            # For validation tasks, we only need to forward to backend for Redis update
            # No need to update task status in database (validation tasks don't exist in DB)
            logger.info(
                f"Successfully processed validation callback for task {request.task_id}"
            )
            return {
                "status": "success",
                "message": f"Successfully processed validation callback for task {request.task_id}",
            }

        # For regular tasks, update task status in database
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
            logger.warning(
                f"Failed to update status for task {request.task_id}: {result}"
            )
        logger.info(f"Successfully processed callback for task {request.task_id}")
        return {
            "status": "success",
            "message": f"Successfully processed callback for task {request.task_id}",
        }
    except Exception as e:
        logger.error(f"Error processing callback: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _forward_validation_callback(request: CallbackRequest):
    """Forward validation task callback to Backend for Redis status update"""
    import httpx

    # Get validation_id from result if available
    validation_id = request.result.get("validation_id") if request.result else None
    if not validation_id:
        # If no validation_id in result, we can't forward to backend
        # This can happen when task_type is "validation" but result is None (e.g., early failure)
        logger.warning(
            f"Validation callback for task {request.task_id} has no validation_id, skipping forward"
        )
        return

    # Map callback status to validation status (case-insensitive)
    status_lower = request.status.lower() if request.status else ""
    status_mapping = {
        "running": "running_checks",
        "completed": "completed",
        "failed": "completed",
    }
    validation_status = status_mapping.get(status_lower, request.status)

    # Extract validation result from callback
    validation_result = request.result.get("validation_result", {})
    stage = request.result.get("stage", "Running checks")
    progress = request.progress

    # For failed status, ensure valid is False if not explicitly set
    valid_value = validation_result.get("valid")
    if status_lower == "failed" and valid_value is None:
        valid_value = False

    # Build update payload
    update_payload = {
        "status": validation_status,
        "stage": stage,
        "progress": progress,
        "valid": valid_value,
        "checks": validation_result.get("checks"),
        "errors": validation_result.get("errors"),
        "errorMessage": request.error_message,
        "executor_name": request.executor_name,  # Include executor_name for container cleanup
    }

    # Get backend URL
    task_api_domain = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")
    update_url = f"{task_api_domain}/api/shells/validation-status/{validation_id}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(update_url, json=update_payload)
            if response.status_code == 200:
                logger.info(
                    f"Successfully forwarded validation callback: {validation_id} -> {validation_status}, valid={valid_value}"
                )
            else:
                logger.warning(
                    f"Failed to forward validation callback: {response.status_code} {response.text}"
                )
    except Exception as e:
        logger.error(f"Error forwarding validation callback: {e}")


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


@app.get("/", response_class=PlainTextResponse)
async def root_health_check():
    """Root health check endpoint for load balancers that check /"""
    return "ok"


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
        logger.info(
            f"Received request to delete executor: {request.executor_name} from {client_ip}"
        )
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


class ValidateImageRequest(BaseModel):
    """Request body for validating base image compatibility"""

    image: str
    shell_type: str  # e.g., "ClaudeCode", "Agno"
    user_name: Optional[str] = None
    shell_name: Optional[str] = None  # Optional shell name for tracking
    validation_id: Optional[str] = None  # UUID for tracking validation status


class ImageCheckResult(BaseModel):
    """Individual check result"""

    name: str
    version: Optional[str] = None
    status: str  # 'pass' or 'fail'
    message: Optional[str] = None


class ValidateImageResponse(BaseModel):
    """Response for image validation"""

    status: str  # 'submitted' for async validation
    message: str
    validation_task_id: Optional[int] = None


@app.post("/executor-manager/images/validate")
async def validate_image(request: ValidateImageRequest, http_request: Request):
    """
    Validate if a base image is compatible with a specific shell type.

    This endpoint creates a validation task that runs inside the target image container.
    The validation is asynchronous - results are returned via callback mechanism.

    For ClaudeCode: checks Node.js 20.x, claude-code CLI, SQLite 3.50+, Python 3.12
    For Agno: checks Python 3.12
    For Dify: No check needed (external_api type)

    The validation task will:
    1. Start a container with the specified base_image
    2. Run ImageValidatorAgent to execute validation checks
    3. Report results back via callback with validation_result in result field
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"Received image validation request: image={request.image}, shell_type={request.shell_type}, validation_id={request.validation_id} from {client_ip}"
    )

    shell_type = request.shell_type
    image = request.image
    validation_id = request.validation_id

    # Dify doesn't need validation (external_api type)
    if shell_type == "Dify":
        return {
            "status": "skipped",
            "message": "Dify is an external_api type and doesn't require image validation",
            "valid": True,
            "checks": [],
            "errors": [],
        }

    # Validate shell_type
    if shell_type not in ["ClaudeCode", "Agno"]:
        return {
            "status": "error",
            "message": f"Unknown shell type: {shell_type}",
            "valid": False,
            "checks": [],
            "errors": [f"Unknown shell type: {shell_type}"],
        }

    # Build validation task data
    # Use a unique negative task_id to distinguish validation tasks from regular tasks
    import time

    validation_task_id = (
        int(time.time() * 1000) % 1000000
    )  # Negative ID for validation tasks

    validation_task = {
        "task_id": validation_task_id,
        "subtask_id": 1,
        "task_title": f"Image Validation: {request.shell_name or image}",
        "subtask_title": f"Validating {shell_type} dependencies",
        "type": "validation",
        "bot": [
            {
                "agent_name": "ImageValidator",
                "base_image": image,  # Use the target image for validation
            }
        ],
        "user": {
            "name": request.user_name or "validator",
        },
        "validation_params": {
            "shell_type": shell_type,
            "image": image,
            "shell_name": request.shell_name or "",
            "validation_id": validation_id,  # Pass validation_id for callback forwarding
        },
        "executor_image": os.getenv("EXECUTOR_IMAGE", ""),
    }

    try:
        # Submit validation task using the task processor
        task_processor.process_tasks([validation_task])

        logger.info(
            f"Validation task submitted: task_id={validation_task_id}, validation_id={validation_id}, image={image}"
        )

        return {
            "status": "submitted",
            "message": f"Validation task submitted. Results will be returned via callback.",
            "validation_task_id": validation_task_id,
        }

    except Exception as e:
        logger.error(f"Failed to submit validation task for {image}: {e}")
        return {
            "status": "error",
            "message": f"Failed to submit validation task: {str(e)}",
            "valid": False,
            "checks": [],
            "errors": [str(e)],
        }


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
        logger.info(
            f"Received request to cancel task {request.task_id} from {client_ip}"
        )

        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        result = executor.cancel_task(request.task_id)

        if result["status"] == "success":
            logger.info(f"Successfully cancelled task {request.task_id}")
            return result
        else:
            logger.warning(
                f"Failed to cancel task {request.task_id}: {result.get('error_msg', 'Unknown error')}"
            )
            raise HTTPException(
                status_code=400, detail=result.get("error_msg", "Failed to cancel task")
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling task {request.task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
