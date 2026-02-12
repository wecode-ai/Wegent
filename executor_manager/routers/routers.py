#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
API routes module, defines FastAPI routes and models.

Callback endpoint uses pure transparent proxy pattern - forwards all events
to backend's callback endpoint without processing.
"""

import os
import time
import uuid
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, Body, FastAPI, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from executor_manager.common.config import ROUTE_PREFIX
from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.executors.docker.constants import DEFAULT_DOCKER_HOST
from executor_manager.executors.docker.utils import get_running_task_details
from executor_manager.tasks.task_processor import TaskProcessor
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.telemetry.config import get_otel_config
from shared.telemetry.context import (
    set_request_context,
    set_task_context,
    set_user_context,
)
from shared.utils.http_client import traced_async_client

# Setup logger
logger = setup_logger(__name__)

# In-memory registry: validation task_id -> {validation_id, shell_type, image, created_at}
# Used by callback_handler to update Redis validation status when validation completes.
# Entries are cleaned up on terminal callback events or after TTL (5 min).
_validation_task_registry: Dict[int, Dict[str, Any]] = {}

# Maximum age for validation registry entries before cleanup (seconds)
_VALIDATION_REGISTRY_MAX_AGE = 300

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

# Create task processor for validation tasks
task_processor = TaskProcessor()

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

    Pure transparent proxy - forwards all events to backend's callback endpoint.
    Event format is OpenAI Responses API format from executor.

    Args:
        event_data: Event data dict in OpenAI Responses API format.

    Returns:
        dict: Processing result
    """
    try:
        client_ip = http_request.client.host if http_request.client else "unknown"

        # Extract task_id and subtask_id for logging and tracing
        task_id = event_data.get("task_id", 0)
        subtask_id = event_data.get("subtask_id", 0)
        event_type = event_data.get("event_type", "")

        logger.info(
            f"[Callback] Received from {client_ip}: "
            f"event_type={event_type}, task_id={task_id}, subtask_id={subtask_id}"
        )

        # Set task context for tracing
        set_task_context(task_id=task_id, subtask_id=subtask_id)

        # Pure transparent proxy - forward to backend
        task_api_domain = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")
        callback_url = f"{task_api_domain}/api/internal/callback"

        async with traced_async_client(timeout=30.0) as client:
            response = await client.post(callback_url, json=event_data)
            if response.status_code != 200:
                logger.warning(
                    f"[Callback] Backend returned error: "
                    f"{response.status_code} {response.text}"
                )

        # Handle terminal events - remove from RunningTaskTracker
        from shared.models.responses_api import ResponsesAPIStreamEvents

        terminal_events = {
            ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
            ResponsesAPIStreamEvents.ERROR.value,
            ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
        }
        if event_type in terminal_events:
            # Bridge validation task callbacks to Redis validation status
            validation_meta = _validation_task_registry.pop(task_id, None)
            if validation_meta:
                await _update_validation_status_from_callback(
                    validation_meta, event_type, event_data
                )

            try:
                from executor_manager.services.task_heartbeat_manager import (
                    get_running_task_tracker,
                )

                tracker = get_running_task_tracker()
                logger.info(
                    f"[Callback] Removing task {task_id} from RunningTaskTracker "
                    f"(source: callback, event_type={event_type})"
                )
                tracker.remove_running_task(task_id)
            except Exception as e:
                logger.warning(f"Failed to remove task from RunningTaskTracker: {e}")

        logger.info(f"[Callback] Successfully forwarded for task {task_id}")
        return {
            "status": "success",
            "message": f"Successfully forwarded callback for task {task_id}",
        }
    except Exception as e:
        logger.error(f"[Callback] Error processing callback: {e}")
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


def _cleanup_stale_validation_entries() -> None:
    """Remove stale entries from the validation task registry (>5 min old)."""
    now = time.time()
    stale_keys = [
        k
        for k, v in _validation_task_registry.items()
        if now - v.get("created_at", 0) > _VALIDATION_REGISTRY_MAX_AGE
    ]
    for k in stale_keys:
        _validation_task_registry.pop(k, None)
        logger.info(f"[Validation] Cleaned up stale validation entry: task_id={k}")


def _extract_validation_result_from_event(event_data: dict) -> Optional[Dict[str, Any]]:
    """Extract validation result from a response.completed callback event.

    The ImageValidatorAgent stores its validation result as JSON in the
    done_event content, which ends up at:
      data.response.output[0].content[0].text

    Args:
        event_data: Full callback event data dict

    Returns:
        Parsed validation result dict, or None if not found/parseable
    """
    import json

    try:
        response = event_data.get("data", {}).get("response", {})
        output_items = response.get("output", [])
        for item in output_items:
            if not isinstance(item, dict):
                continue
            for content_part in item.get("content", []):
                if not isinstance(content_part, dict):
                    continue
                text = content_part.get("text", "")
                if not text:
                    continue
                try:
                    result = json.loads(text)
                    if isinstance(result, dict) and "valid" in result:
                        return result
                except (json.JSONDecodeError, TypeError):
                    continue
    except Exception:
        pass
    return None


async def _update_validation_status_from_callback(
    validation_meta: Dict[str, Any],
    event_type: str,
    event_data: dict,
) -> None:
    """Bridge callback terminal events to Redis validation status for frontend polling.

    When a validation task completes via the callback chain, this function
    forwards the result to the backend's validation-status endpoint so the
    Redis entry gets updated and the frontend polling can see the completion.

    Args:
        validation_meta: Validation metadata from _validation_task_registry
        event_type: Terminal event type (response.completed, error, etc.)
        event_data: Full event data dict from the callback
    """
    from shared.models.responses_api import ResponsesAPIStreamEvents

    validation_id = validation_meta.get("validation_id")
    if not validation_id:
        return

    task_api_domain = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")
    update_url = f"{task_api_domain}/api/shells/validation-status/{validation_id}"

    if event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
        update_payload: Dict[str, Any] = {
            "status": "completed",
            "stage": "Validation completed",
            "progress": 100,
            "valid": True,
        }
        # Try to extract detailed validation results from event content
        # The content is at data.response.output[0].content[0].text
        # and contains JSON-serialized validation_result from ImageValidatorAgent
        validation_result = _extract_validation_result_from_event(event_data)
        if validation_result:
            update_payload["valid"] = validation_result.get("valid", True)
            if validation_result.get("checks"):
                update_payload["checks"] = validation_result["checks"]
            if validation_result.get("errors"):
                update_payload["errors"] = validation_result["errors"]
    elif event_type == ResponsesAPIStreamEvents.ERROR.value:
        error_data = event_data.get("data", {})
        error_obj = error_data.get("error")
        if isinstance(error_obj, dict):
            error_message = error_obj.get("message", "Unknown error")
        else:
            error_message = str(error_obj or "Validation failed")
        update_payload = {
            "status": "completed",
            "stage": "Validation failed",
            "progress": 100,
            "valid": False,
            "errorMessage": error_message,
        }
    else:
        # response.incomplete or other terminal events
        update_payload = {
            "status": "completed",
            "stage": "Validation incomplete",
            "progress": 100,
            "valid": False,
            "errorMessage": "Validation task did not complete normally",
        }

    # Include executor_name for container cleanup by the backend
    executor_name = event_data.get("executor_name")
    if executor_name:
        update_payload["executor_name"] = executor_name

    try:
        async with traced_async_client(timeout=10.0) as client:
            response = await client.post(update_url, json=update_payload)
            if response.status_code == 200:
                logger.info(
                    f"[Callback] Updated validation status: "
                    f"{validation_id} valid={update_payload.get('valid')}"
                )
            else:
                logger.warning(
                    f"[Callback] Failed to update validation status: "
                    f"{response.status_code} {response.text}"
                )
    except Exception as e:
        logger.error(
            f"[Callback] Error updating validation status {validation_id}: {e}"
        )


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
        # Clean stale registry entries before registering new one
        _cleanup_stale_validation_entries()

        # Register for callback interception so we can update Redis
        # validation status when the terminal callback event arrives
        _validation_task_registry[validation_task_id] = {
            "validation_id": validation_id,
            "shell_type": shell_type,
            "image": image,
            "created_at": time.time(),
        }

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
# V1 Transparent Proxy APIs (OpenAI Responses API)
# =============================================================================
# These endpoints implement the transparent proxy pattern for task dispatch
# using OpenAI Responses API format with background mode.
# executor_manager only forwards requests to containers without business logic.
# =============================================================================


class OpenAIResponsesRequest(BaseModel):
    """Request model for /v1/responses endpoint (OpenAI Responses API format).

    This is a transparent proxy request that forwards OpenAI Responses API
    format requests to the appropriate executor container.

    Supports background mode (non-streaming) for HTTP+Callback dispatch.
    """

    # OpenAI Responses API standard fields
    model: str
    input: Any  # Can be string or list of messages
    instructions: Optional[str] = None
    stream: bool = False

    # Background mode flag (OpenAI extension)
    background: bool = False

    # Custom metadata for task identification
    metadata: Optional[Dict[str, Any]] = None

    # Model configuration
    model_config_data: Optional[Dict[str, Any]] = None

    class Config:
        # Allow extra fields for forward compatibility
        extra = "allow"


class CancelRequest(BaseModel):
    """Request model for /v1/cancel endpoint."""

    task_id: int
    subtask_id: Optional[int] = None
    executor_name: Optional[str] = None


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
                async with traced_async_client(timeout=10.0) as client:
                    response = await client.post(cancel_url)
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


@api_router.post("/v1/responses")
async def openai_responses(http_request: Request):
    """OpenAI Responses API endpoint - async queue mode.

    This endpoint accepts OpenAI Responses API format requests and enqueues
    them directly to Redis for async processing. The OpenAI format is stored
    as-is in the queue - no conversion to ExecutionRequest format.
    The task queue consumer will handle container creation and task execution.

    Request format (OpenAI Responses API):
    {
        "model": "...",
        "input": "..." or [...],
        "instructions": "...",
        "stream": false,
        "background": true,
        "metadata": {
            "task_id": 123,
            "subtask_id": 456,
            "type": "online",
            ...
        },
        "model_config": {...}
    }

    Args:
        http_request: HTTP request object

    Returns:
        dict: Queued status response
    """
    client_ip = http_request.client.host if http_request.client else "unknown"

    # Read raw JSON data from request body
    body_bytes = await http_request.body()
    import json

    request_data = json.loads(body_bytes)

    # Extract task identification from metadata
    metadata = request_data.get("metadata", {})
    task_id = metadata.get("task_id", 0)
    subtask_id = metadata.get("subtask_id", 0)
    background = request_data.get("background", False)

    logger.info(
        f"[v1/responses] Received OpenAI request: task_id={task_id}, "
        f"subtask_id={subtask_id}, background={background} from {client_ip}"
    )

    # Set task context for tracing
    set_task_context(task_id=task_id, subtask_id=subtask_id)

    try:
        # Enqueue OpenAI format directly to Redis (no conversion needed)
        from executor_manager.services.task_queue_service import TaskQueueService

        queue_type = metadata.get("type") or "online"
        service_pool = os.getenv("SERVICE_POOL", "default")
        queue_service = TaskQueueService(service_pool, queue_type)
        success = queue_service.enqueue_task(request_data)

        if not success:
            logger.error(f"[v1/responses] Failed to enqueue task {task_id}")
            raise HTTPException(status_code=500, detail="Failed to enqueue task")

        logger.info(
            f"[v1/responses] Task {task_id} enqueued to "
            f"pool '{service_pool}' queue '{queue_type}'"
        )

        return {
            "id": f"resp_{subtask_id}",
            "status": "queued",
            "message": "Task enqueued for processing",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[v1/responses] Error processing request for task {task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
