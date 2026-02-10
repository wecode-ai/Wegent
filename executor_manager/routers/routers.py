#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
API routes module, defines FastAPI routes and models.

Uses unified ExecutionRequest and ExecutionEvent from shared.models.execution.
"""

import os
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Body, FastAPI, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.common.config import ROUTE_PREFIX
from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.executors.docker.constants import DEFAULT_DOCKER_HOST
from executor_manager.tasks.task_processor import TaskProcessor
from shared.logger import setup_logger
from shared.models.execution import EventType, ExecutionEvent, ExecutionRequest
from shared.telemetry.config import get_otel_config
from shared.telemetry.context import (
    set_request_context,
    set_task_context,
    set_user_context,
)

# Setup logger
logger = setup_logger(__name__)

# Create FastAPI app
app = FastAPI(
    title="Executor Manager API",
    description="API for managing executor tasks and callbacks",
)

# E2B Standard API routes
from executor_manager.routers.e2b import router as e2b_router
from executor_manager.routers.sandbox import router as sandbox_router

# Wegent E2B private protocol proxy routes
from executor_manager.routers.wegent_e2b_proxy import router as wegent_e2b_proxy_router

# Create main API router with unified prefix
api_router = APIRouter(prefix=ROUTE_PREFIX)

# Mount sub-routers to api_router
api_router.include_router(sandbox_router)
# E2B standard endpoints:
# - /executor-manager/e2b/sandboxes - Create sandbox (POST), Get sandbox (GET), Delete (DELETE)
# - /executor-manager/e2b/v2/sandboxes - List sandboxes
# - /executor-manager/e2b/sandboxes/{id}/timeout - Set timeout
# - /executor-manager/e2b/sandboxes/{id}/pause - Pause sandbox
# - /executor-manager/e2b/sandboxes/{id}/resume - Resume sandbox
# - /executor-manager/e2b/sandboxes/{id}/connect - Connect to sandbox
api_router.include_router(e2b_router, prefix="/e2b")
# Private protocol proxy for sandbox access
# Routes: /executor-manager/e2b/proxy/<sandboxID>/<port>/<path> -> container
api_router.include_router(wegent_e2b_proxy_router, prefix="/e2b/proxy")

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

    # Get request_id from header (propagated from upstream service) or generate new one
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())[:8]
    request.state.request_id = request_id

    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"

    # Always set request context for logging (works even without OTEL)
    from shared.telemetry.context import set_request_context

    set_request_context(request_id)

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

            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
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


@api_router.post("/callback")
async def callback_handler(event_data: dict = Body(...), http_request: Request = None):
    """
    Receive callback interface for executor task progress and completion.

    Uses unified ExecutionEvent from shared.models.execution.

    Args:
        event_data: Event data dict that will be converted to ExecutionEvent.

    Returns:
        dict: Processing result
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(f"Received callback from {client_ip}")

        # Parse event using unified ExecutionEvent
        event = ExecutionEvent.from_dict(event_data)

        # [DEBUG] Log result content for streaming debugging
        if event.result:
            result_value = event.result.get("value", "")
            result_thinking = event.result.get("thinking", [])
            logger.info(
                f"[DEBUG] Callback result: task_id={event.task_id}, "
                f"status={event.status}, progress={event.progress}, "
                f"value_length={len(result_value) if result_value else 0}, "
                f"thinking_count={len(result_thinking)}"
            )
            if result_value:
                # Log first 200 chars of content
                preview = (
                    result_value[:200] if len(result_value) > 200 else result_value
                )
                logger.info(f"[DEBUG] Content preview: {preview}...")

        # Set task context for tracing (function handles OTEL enabled check internally)
        set_task_context(task_id=event.task_id, subtask_id=event.subtask_id)

        # Check task type from event data (validation, sandbox, or regular)
        # Use data field for task_type since ExecutionEvent doesn't have task_type directly
        task_type = event.data.get("task_type", "")

        # Check if this is a validation task callback
        # Primary check: task_type == "validation"
        # Fallback check: validation_id in result (for backward compatibility)
        is_validation_task = task_type == "validation" or (
            event.result and event.result.get("validation_id")
        )
        if is_validation_task:
            await _forward_validation_callback(event)
            # For validation tasks, we only need to forward to backend for Redis update
            # No need to update task status in database (validation tasks don't exist in DB)
            logger.info(
                f"Successfully processed validation callback for task {event.task_id}"
            )
            return {
                "status": "success",
                "message": f"Successfully processed validation callback for task {event.task_id}",
            }

        # Check if this is a Sandbox execution callback
        is_sandbox_task = task_type == "sandbox"
        if is_sandbox_task:
            await _handle_sandbox_callback(event)
            logger.info(
                f"Successfully processed Sandbox callback for task {event.task_id}"
            )
            return {
                "status": "success",
                "message": f"Successfully processed Sandbox callback for task {event.task_id}",
            }

        # For regular tasks, update task status in database
        # Extract title from data field if present
        task_title = event.data.get("task_title")
        success, result = api_client.update_task_status_by_fields(
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            progress=event.progress,
            executor_name=event.executor_name,
            executor_namespace=event.executor_namespace,
            status=event.status,
            error_message=event.error,
            title=task_title,
            result=event.result,
        )
        if not success:
            logger.warning(
                f"Failed to update status for task {event.task_id}: {result}"
            )

        # Remove task from RunningTaskTracker when completed or failed
        # This prevents false-positive heartbeat timeout detection
        status_lower = event.status.lower() if event.status else ""
        if status_lower in ("completed", "failed", "cancelled", "success"):
            try:
                from executor_manager.services.task_heartbeat_manager import (
                    get_running_task_tracker,
                )

                tracker = get_running_task_tracker()
                logger.info(
                    f"[Callback] Removing task {event.task_id} from RunningTaskTracker "
                    f"(source: callback, status={status_lower})"
                )
                tracker.remove_running_task(event.task_id)
            except Exception as e:
                logger.warning(f"Failed to remove task from RunningTaskTracker: {e}")

        logger.info(f"Successfully processed callback for task {event.task_id}")
        return {
            "status": "success",
            "message": f"Successfully processed callback for task {event.task_id}",
        }
    except Exception as e:
        logger.error(f"Error processing callback: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _forward_validation_callback(event: ExecutionEvent):
    """Forward validation task callback to Backend for Redis status update.

    Args:
        event: ExecutionEvent containing validation callback data
    """
    # Get validation_id from result if available
    validation_id = event.result.get("validation_id") if event.result else None
    if not validation_id:
        # If no validation_id in result, we can't forward to backend
        # This can happen when task_type is "validation" but result is None (e.g., early failure)
        logger.warning(
            f"Validation callback for task {event.task_id} has no validation_id, skipping forward"
        )
        return

    # Map callback status to validation status (case-insensitive)
    status_lower = event.status.lower() if event.status else ""
    status_mapping = {
        "running": "running_checks",
        "completed": "completed",
        "failed": "completed",
    }
    validation_status = status_mapping.get(status_lower, event.status)

    # Extract validation result from callback
    validation_result = event.result.get("validation_result", {})
    stage = event.result.get("stage", "Running checks")
    progress = event.progress

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
        "errorMessage": event.error,
        "executor_name": event.executor_name,  # Include executor_name for container cleanup
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


async def _handle_sandbox_callback(event: ExecutionEvent):
    """Handle Sandbox execution callback.

    This function updates the execution status in sandbox_manager based on
    the callback from executor container.

    Args:
        event: ExecutionEvent containing execution status and result
    """
    from executor_manager.services.sandbox import get_sandbox_manager

    # Use task_id and subtask_id from event to identify execution
    task_id = event.task_id
    subtask_id = event.subtask_id

    logger.info(
        f"[SandboxCallback] Processing callback: "
        f"task_id={task_id}, subtask_id={subtask_id}, "
        f"status={event.status}, progress={event.progress}"
    )

    # Get sandbox manager
    manager = get_sandbox_manager()

    # Load execution from Redis Hash by task_id and subtask_id
    execution = manager._repository.load_execution(task_id, subtask_id)
    if not execution:
        logger.error(
            f"[SandboxCallback] Execution not found in Redis: "
            f"task_id={task_id}, subtask_id={subtask_id}"
        )
        return

    # Update execution status based on callback
    status_lower = event.status.lower() if event.status else ""

    if status_lower == "completed":
        # Extract result from callback
        result_value = None
        if event.result:
            result_value = event.result.get("value", "")

        execution.set_completed(result_value or "")
        logger.info(
            f"[SandboxCallback] Execution completed: "
            f"task_id={task_id}, subtask_id={subtask_id}, "
            f"result_length={len(result_value) if result_value else 0}"
        )

    elif status_lower == "failed":
        error_msg = event.error or "Execution failed"
        execution.set_failed(error_msg)
        logger.info(
            f"[SandboxCallback] Execution failed: "
            f"task_id={task_id}, subtask_id={subtask_id}, error={error_msg}"
        )

    elif status_lower == "running":
        # Update progress for running status
        execution.progress = event.progress
        logger.debug(
            f"[SandboxCallback] Execution progress: "
            f"task_id={task_id}, subtask_id={subtask_id}, progress={event.progress}"
        )

    else:
        logger.warning(
            f"[SandboxCallback] Unknown status: "
            f"task_id={task_id}, subtask_id={subtask_id}, status={event.status}"
        )

    # Save updated execution state to Redis
    # Set update_activity=True because callback indicates the sandbox is actively being used
    manager._repository.save_execution(execution, update_activity=True)

    logger.info(
        f"[SandboxCallback] Execution updated: "
        f"task_id={task_id}, subtask_id={subtask_id}, status={execution.status.value}"
    )


def _verify_task_token(auth_header: Optional[str]) -> bool:
    """Verify JWT token from Authorization header.

    The token should be created by backend using the same SECRET_KEY.
    This verification ensures the request is from a trusted source.

    Args:
        auth_header: Authorization header value (e.g., "Bearer xxx")

    Returns:
        True if token is valid, False otherwise
    """
    if not auth_header:
        return False

    if not auth_header.startswith("Bearer "):
        return False

    token = auth_header[7:]  # Remove "Bearer " prefix
    secret_key = os.getenv("JWT_SECRET_KEY", "your-secret-key-here")
    algorithm = os.getenv("JWT_ALGORITHM", "HS256")

    try:
        from jose import JWTError, jwt

        # Just verify the token is valid, no need to check specific claims
        jwt.decode(token, secret_key, algorithms=[algorithm])
        return True
    except Exception as e:
        logger.warning(f"JWT verification failed: {e}")
        return False


@api_router.post("/tasks/receive")
async def receive_tasks(
    request_data: dict = Body(...),
    http_request: Request = None,
    queue_type: str = "online",
):
    """
    Receive tasks in batch via POST.

    Uses unified ExecutionRequest from shared.models.execution.
    Accepts a dict with 'tasks' key containing list of task dicts.

    This endpoint supports two modes controlled by TASK_DISPATCH_MODE:
    - pull (default): Process tasks directly via TaskProcessor
    - push: Enqueue tasks to Redis for async processing with backpressure

    In push mode, tasks are routed to either online or offline queue:
    - online (default): Processed immediately by online consumer
    - offline: Processed during night hours (21:00-08:00) by offline consumer

    Authentication is optional, controlled by TASK_RECEIVE_AUTH_REQUIRED env var.

    Args:
        request_data: Dict with 'tasks' key containing list of ExecutionRequest dicts.
        queue_type: Queue type ('online' or 'offline'), default is 'online'.
    Returns:
        dict: result code
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"

        # Parse tasks from request data
        tasks_data = request_data.get("tasks", [])
        if not tasks_data:
            logger.warning(f"No tasks in request from {client_ip}")
            return {"code": 0}

        # Convert to ExecutionRequest objects for validation and processing
        tasks = [ExecutionRequest.from_dict(task_dict) for task_dict in tasks_data]

        logger.info(
            f"Received {len(tasks)} tasks (queue_type={queue_type}), "
            f"first task: {tasks[0].task_title if tasks else 'None'} from {client_ip}"
        )

        # Validate queue_type
        if queue_type not in ("online", "offline"):
            logger.warning(f"Invalid queue_type '{queue_type}', defaulting to 'online'")
            queue_type = "online"

        # Optional JWT authentication
        auth_required = (
            os.getenv("TASK_RECEIVE_AUTH_REQUIRED", "false").lower() == "true"
        )
        if auth_required:
            auth_header = http_request.headers.get("Authorization")
            if not _verify_task_token(auth_header):
                logger.warning(f"Unauthorized task receive request from {client_ip}")
                raise HTTPException(
                    status_code=401, detail="Invalid or missing authorization token"
                )

        # Set task context for tracing (use first task's context)
        # Functions handle OTEL enabled check internally
        if tasks:
            first_task = tasks[0]
            set_task_context(
                task_id=first_task.task_id, subtask_id=first_task.subtask_id
            )
            user_data = first_task.user
            set_user_context(
                user_id=str(user_data.get("id", "")),
                user_name=user_data.get("name", ""),
            )

        # Check dispatch mode
        dispatch_mode = os.getenv("TASK_DISPATCH_MODE", "pull")

        if dispatch_mode == "push":
            # Push mode: enqueue to Redis for async processing with backpressure
            from executor_manager.services.task_queue_service import TaskQueueService

            service_pool = os.getenv("SERVICE_POOL", "default")
            queue_service = TaskQueueService(service_pool, queue_type)

            # Convert ExecutionRequest objects to dicts for queue
            tasks_dicts = [task.to_dict() for task in tasks]
            enqueued = queue_service.enqueue_tasks(tasks_dicts)

            logger.info(
                f"Push mode: enqueued {enqueued}/{len(tasks)} tasks to "
                f"pool '{service_pool}' queue '{queue_type}'"
            )
        else:
            # Pull mode (default): process tasks directly
            # Convert ExecutionRequest objects to dicts for task processor
            tasks_dicts = [task.to_dict() for task in tasks]
            task_processor.process_tasks(tasks_dicts)

        return {"code": 0}
    except HTTPException:
        raise
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


@app.get("/ready")
async def readiness_check():
    """Readiness probe endpoint."""
    return {"status": "ready"}


class DeleteExecutorRequest(BaseModel):
    executor_name: str


@api_router.post("/executor/delete")
async def delete_executor(request: DeleteExecutorRequest, http_request: Request):
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"
        logger.info(
            f"Received request to delete executor: {request.executor_name} from {client_ip}"
        )

        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)

        # Get task_id from executor before deletion (for cleanup)
        task_id_str = executor.get_executor_task_id(request.executor_name)

        result = executor.delete_executor(request.executor_name)

        # Clean up running task tracker if we got task_id
        if task_id_str:
            try:
                from executor_manager.services.heartbeat_manager import (
                    HeartbeatType,
                    get_heartbeat_manager,
                )
                from executor_manager.services.task_heartbeat_manager import (
                    get_running_task_tracker,
                )

                task_id = int(task_id_str)
                tracker = get_running_task_tracker()
                heartbeat_mgr = get_heartbeat_manager()

                await heartbeat_mgr.delete_heartbeat(task_id_str, HeartbeatType.TASK)
                logger.info(
                    f"[DeleteExecutor] Removing task {task_id} from RunningTaskTracker "
                    f"(source: delete_executor, executor_name={request.executor_name})"
                )
                tracker.remove_running_task(task_id)
            except Exception as e:
                logger.warning(f"Failed to clean up running task tracker: {e}")

        return result
    except Exception as e:
        logger.error(f"Error deleting executor '{request.executor_name}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/executor/load")
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


@api_router.post("/images/validate")
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


@api_router.post("/tasks/cancel")
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

        # Set task context for tracing (function handles OTEL enabled check internally)
        set_task_context(task_id=request.task_id)

        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
        result = executor.cancel_task(request.task_id)

        if result["status"] == "success":
            logger.info(f"Successfully cancelled task {request.task_id}")

            # Clean up Redis heartbeat data immediately on cancel
            try:
                from executor_manager.services.heartbeat_manager import (
                    HeartbeatType,
                    get_heartbeat_manager,
                )
                from executor_manager.services.task_heartbeat_manager import (
                    get_running_task_tracker,
                )

                task_id_str = str(request.task_id)
                heartbeat_mgr = get_heartbeat_manager()
                tracker = get_running_task_tracker()

                # Delete heartbeat key
                await heartbeat_mgr.delete_heartbeat(task_id_str, HeartbeatType.TASK)
                # Remove from running tasks tracker
                logger.info(
                    f"[CancelTask] Removing task {request.task_id} from RunningTaskTracker "
                    f"(source: cancel_task)"
                )
                tracker.remove_running_task(request.task_id)
            except Exception as e:
                logger.warning(f"Failed to clean up heartbeat data: {e}")

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


# =============================================================================
# V1 Transparent Proxy APIs
# =============================================================================
# These endpoints implement the transparent proxy pattern for task dispatch.
# executor_manager only forwards requests to containers without business logic.
# =============================================================================


class ExecuteRequest(BaseModel):
    """Request model for /v1/execute endpoint.

    This is a transparent proxy request that forwards TaskExecutionRequest
    to the appropriate executor container.
    """

    # Container identification (optional - if provided, forward to existing container)
    executor_name: Optional[str] = None

    # Task identification (required for new container creation)
    task_id: int
    subtask_id: int

    # Shell type for routing (required for new container creation)
    shell_type: Optional[str] = None

    # Full request payload to forward to container
    # This contains the complete TaskExecutionRequest data
    payload: Dict[str, Any]


class CancelRequest(BaseModel):
    """Request model for /v1/cancel endpoint."""

    task_id: int
    subtask_id: Optional[int] = None
    executor_name: Optional[str] = None


async def _forward_to_container(
    executor_name: str, request_data: Dict[str, Any]
) -> Dict[str, Any]:
    """Forward request to an existing container.

    This is a pure proxy function - no business logic processing.

    Args:
        executor_name: Name of the target container
        request_data: Request payload to forward

    Returns:
        Response from the container

    Raises:
        HTTPException: If container not found or forwarding fails
    """
    executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)

    # Get container port
    port, error = executor._get_container_port(executor_name)
    if not port:
        logger.warning(f"Container {executor_name} not found or has no port: {error}")
        raise HTTPException(
            status_code=404,
            detail=f"Container {executor_name} not found: {error}",
        )

    # Forward request to container
    endpoint = f"http://{DEFAULT_DOCKER_HOST}:{port}/api/tasks/execute"
    logger.info(f"Forwarding request to container {executor_name} at {endpoint}")

    try:
        # Propagate trace context headers
        headers = {}
        try:
            from shared.telemetry.context import (
                get_request_id,
                inject_trace_context_to_headers,
            )

            headers = inject_trace_context_to_headers(headers)
            request_id = get_request_id()
            if request_id:
                headers["X-Request-ID"] = request_id
        except Exception as e:
            logger.debug(f"Failed to inject trace context headers: {e}")

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(endpoint, json=request_data, headers=headers)

            if response.status_code == 200:
                return response.json()
            else:
                logger.warning(
                    f"Container {executor_name} returned error: "
                    f"{response.status_code} {response.text}"
                )
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Container error: {response.text}",
                )

    except httpx.RequestError as e:
        logger.error(f"Failed to forward request to container {executor_name}: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Failed to communicate with container: {str(e)}",
        )


@api_router.post("/v1/execute")
async def execute_task(request: ExecuteRequest, http_request: Request):
    """Unified execution endpoint - transparent proxy.

    This endpoint implements the transparent proxy pattern:
    1. If executor_name is provided, forward request to existing container
    2. Otherwise, create a new container and submit the task

    The executor_manager does NOT process any business logic here.
    It only handles container routing and forwarding.

    Args:
        request: ExecuteRequest containing task info and optional executor_name
        http_request: HTTP request object

    Returns:
        dict: Execution result from container or container creation status
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[v1/execute] Received request: task_id={request.task_id}, "
        f"subtask_id={request.subtask_id}, executor_name={request.executor_name} "
        f"from {client_ip}"
    )

    # Set task context for tracing
    set_task_context(task_id=request.task_id, subtask_id=request.subtask_id)

    try:
        if request.executor_name:
            # Forward to existing container
            logger.info(
                f"[v1/execute] Forwarding to existing container: {request.executor_name}"
            )
            return await _forward_to_container(request.executor_name, request.payload)
        else:
            # Create new container and submit task
            logger.info(
                f"[v1/execute] Creating new container for task {request.task_id}"
            )

            executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)

            # Build task data for container creation
            # The payload already contains the full TaskExecutionRequest
            task_data = request.payload.copy()
            task_data["task_id"] = request.task_id
            task_data["subtask_id"] = request.subtask_id

            # Submit to executor (creates container and sends task)
            result = executor.submit_executor(task_data)

            logger.info(
                f"[v1/execute] Container creation result: status={result.get('status')}, "
                f"executor_name={result.get('executor_name')}"
            )

            return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[v1/execute] Error executing task {request.task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/v1/cancel")
async def cancel_task_v1(request: CancelRequest, http_request: Request):
    """Cancel task execution - transparent proxy.

    This endpoint cancels a running task by:
    1. If executor_name is provided, send cancel request directly to that container
    2. Otherwise, find the container by task_id and send cancel request

    Args:
        request: CancelRequest containing task_id and optional executor_name
        http_request: HTTP request object

    Returns:
        dict: Cancellation result
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[v1/cancel] Received request: task_id={request.task_id}, "
        f"subtask_id={request.subtask_id}, executor_name={request.executor_name} "
        f"from {client_ip}"
    )

    # Set task context for tracing
    set_task_context(task_id=request.task_id, subtask_id=request.subtask_id)

    try:
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)

        if request.executor_name:
            # Direct cancel to specified container
            port, error = executor._get_container_port(request.executor_name)
            if not port:
                logger.warning(
                    f"[v1/cancel] Container {request.executor_name} not found: {error}"
                )
                raise HTTPException(
                    status_code=404,
                    detail=f"Container {request.executor_name} not found: {error}",
                )

            # Send cancel request to container
            cancel_url = (
                f"http://{DEFAULT_DOCKER_HOST}:{port}/api/tasks/cancel"
                f"?task_id={request.task_id}"
            )

            try:
                headers = {}
                try:
                    from shared.telemetry.context import (
                        get_request_id,
                        inject_trace_context_to_headers,
                    )

                    headers = inject_trace_context_to_headers(headers)
                    request_id = get_request_id()
                    if request_id:
                        headers["X-Request-ID"] = request_id
                except Exception as e:
                    logger.debug(f"Failed to inject trace context headers: {e}")

                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post(cancel_url, headers=headers)
                    response.raise_for_status()

                logger.info(
                    f"[v1/cancel] Successfully cancelled task {request.task_id} "
                    f"in container {request.executor_name}"
                )

                # Clean up heartbeat data
                await _cleanup_task_heartbeat(request.task_id)

                return {
                    "status": "success",
                    "message": f"Task {request.task_id} cancellation requested",
                    "executor_name": request.executor_name,
                }

            except httpx.RequestError as e:
                logger.error(
                    f"[v1/cancel] Failed to send cancel to container "
                    f"{request.executor_name}: {e}"
                )
                raise HTTPException(
                    status_code=503,
                    detail=f"Failed to communicate with container: {str(e)}",
                )

        else:
            # Find container by task_id and cancel
            result = executor.cancel_task(request.task_id)

            if result.get("status") == "success":
                logger.info(
                    f"[v1/cancel] Successfully cancelled task {request.task_id}"
                )
                await _cleanup_task_heartbeat(request.task_id)
                return result
            else:
                logger.warning(
                    f"[v1/cancel] Failed to cancel task {request.task_id}: "
                    f"{result.get('error_msg')}"
                )
                raise HTTPException(
                    status_code=400,
                    detail=result.get("error_msg", "Failed to cancel task"),
                )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[v1/cancel] Error cancelling task {request.task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _cleanup_task_heartbeat(task_id: int) -> None:
    """Clean up heartbeat data for a cancelled task.

    Args:
        task_id: Task ID to clean up
    """
    try:
        from executor_manager.services.heartbeat_manager import (
            HeartbeatType,
            get_heartbeat_manager,
        )
        from executor_manager.services.task_heartbeat_manager import (
            get_running_task_tracker,
        )

        task_id_str = str(task_id)
        heartbeat_mgr = get_heartbeat_manager()
        tracker = get_running_task_tracker()

        await heartbeat_mgr.delete_heartbeat(task_id_str, HeartbeatType.TASK)
        logger.info(f"[v1/cancel] Removing task {task_id} from RunningTaskTracker")
        tracker.remove_running_task(task_id)
    except Exception as e:
        logger.warning(f"[v1/cancel] Failed to clean up heartbeat data: {e}")


@api_router.post("/tasks/{task_id}/heartbeat")
async def task_heartbeat(task_id: str, http_request: Request):
    """
    Receive heartbeat from executor container for regular (online/offline) tasks.

    This endpoint is called by the executor's HeartbeatService when running
    regular tasks (not sandbox tasks). It updates the heartbeat timestamp in Redis
    to indicate that the executor container is still alive.

    Args:
        task_id: Task ID as string
        http_request: HTTP request object

    Returns:
        dict: Heartbeat acknowledgement
    """
    from executor_manager.services.heartbeat_manager import (
        HeartbeatType,
        get_heartbeat_manager,
    )

    heartbeat_mgr = get_heartbeat_manager()
    success = await heartbeat_mgr.update_heartbeat(task_id, HeartbeatType.TASK)

    if not success:
        logger.warning(f"[TaskAPI] Failed to update heartbeat for task {task_id}")

    return {"status": "ok", "task_id": task_id}


# Mount api_router to app
app.include_router(api_router)
