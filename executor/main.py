#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import time
import uuid
from typing import Dict, Optional, Any
from fastapi import FastAPI, HTTPException, Body, Request, Query, BackgroundTasks
from pydantic import BaseModel
import uvicorn
from executor.tasks import run_task
import os
from contextlib import asynccontextmanager

# Import the shared logger
from shared.logger import setup_logger
from shared.status import TaskStatus
from shared.telemetry.config import get_otel_config
from executor.tasks import process
from executor.services.agent_service import AgentService

# Use the shared logger setup function
logger = setup_logger("task_executor")

# Define lifespan context manager for startup and shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Run task at startup if TASK_INFO is available
    """
    # Initialize OpenTelemetry if enabled (configuration from shared/telemetry/config.py)
    otel_config = get_otel_config("wegent-executor")
    if otel_config.enabled:
        try:
            from shared.telemetry.core import init_telemetry
            from shared.telemetry.context import restore_trace_context_from_env

            init_telemetry(
                service_name=otel_config.service_name,
                enabled=otel_config.enabled,
                otlp_endpoint=otel_config.otlp_endpoint,
                sampler_ratio=otel_config.sampler_ratio,
                service_version="1.0.0",
                metrics_enabled=otel_config.metrics_enabled,
                capture_request_headers=otel_config.capture_request_headers,
                capture_request_body=otel_config.capture_request_body,
                capture_response_headers=otel_config.capture_response_headers,
                capture_response_body=otel_config.capture_response_body,
                max_body_size=otel_config.max_body_size,
            )
            logger.info("OpenTelemetry initialized successfully")

            # Apply instrumentation
            from shared.telemetry.instrumentation import setup_opentelemetry_instrumentation
            setup_opentelemetry_instrumentation(app, logger)

            # Restore parent trace context from environment variables
            # This continues the trace started by executor_manager
            restore_trace_context_from_env()
            logger.debug("Restored trace context from environment")
        except Exception as e:
            logger.warning(f"Failed to initialize OpenTelemetry: {e}")
    try:
        if os.getenv("TASK_INFO"):
            logger.info("TASK_INFO environment variable found, attempting to run task")
            status = run_task()
            logger.info(f"Task execution status: {status}")
        else:
            logger.info(
                "No TASK_INFO environment variable found, skipping task execution"
            )
    except Exception as e:
        logger.exception(f"Error running task at startup: {str(e)}")

    yield  # Application runs here

    # Shutdown OpenTelemetry
    if otel_config.enabled:
        from shared.telemetry.core import shutdown_telemetry
        shutdown_telemetry()
        logger.info("OpenTelemetry shutdown completed")

# Create FastAPI app
app = FastAPI(
    title="Task Executor API",
    description="API for executing tasks with agents",
    lifespan=lifespan
)


# Add middleware for request/response logging and OTEL capture
@app.middleware("http")
async def log_requests(request: Request, call_next):
    from starlette.responses import StreamingResponse

    # Skip logging for health check requests
    if request.url.path == "/":
        return await call_next(request)

    # Generate a unique request ID
    request_id = str(uuid.uuid4())[:8]
    request.state.request_id = request_id

    start_time = time.time()

    # Capture request body if OTEL is enabled and body capture is configured
    # Get OTEL config for middleware checks
    otel_cfg = get_otel_config()
    request_body = None
    if (
        otel_cfg.enabled
        and otel_cfg.capture_request_body
        and request.method in ("POST", "PUT", "PATCH")
    ):
        try:
            body_bytes = await request.body()
            if body_bytes:
                max_body_size = otel_cfg.max_body_size
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
    if otel_cfg.enabled:
        try:
            from opentelemetry import trace
            from shared.telemetry.core import is_telemetry_enabled
            from shared.telemetry.context import set_request_context

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
        f"request : {request.method} {request.url.path} {request.query_params} {request_id}"
    )

    # Process request
    response = await call_next(request)
    process_time = (time.time() - start_time) * 1000

    # Capture response headers and body if OTEL is enabled
    if otel_cfg.enabled:
        try:
            from opentelemetry import trace
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                current_span = trace.get_current_span()
                if current_span and current_span.is_recording():
                    # Capture response headers
                    if otel_cfg.capture_response_headers:
                        for header_name, header_value in response.headers.items():
                            if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                                header_value = "[REDACTED]"
                            current_span.set_attribute(
                                f"http.response.header.{header_name}", header_value
                            )

                    # Capture response body (only for non-streaming responses)
                    if otel_cfg.capture_response_body:
                        if not isinstance(response, StreamingResponse):
                            try:
                                response_body_chunks = []
                                async for chunk in response.body_iterator:
                                    response_body_chunks.append(chunk)

                                response_body = b"".join(response_body_chunks)

                                max_body_size = otel_cfg.max_body_size
                                if response_body:
                                    if len(response_body) <= max_body_size:
                                        body_str = response_body.decode("utf-8", errors="replace")
                                    else:
                                        body_str = (
                                            response_body[:max_body_size].decode("utf-8", errors="replace")
                                            + f"... [truncated, total size: {len(response_body)} bytes]"
                                        )
                                    current_span.set_attribute("http.response.body", body_str)

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
        f"response: {request.method} {request.url.path} {request_id} {response.status_code} {process_time:.2f}ms"
    )

    response.headers["X-Request-ID"] = request_id
    return response


agent_service = AgentService()

class TaskResponse(BaseModel):
    """Response model for task execution"""

    task_id: int
    subtask_id: int
    status: str
    message: str
    progress: int = 0


@app.post("/api/tasks/execute", response_model=TaskResponse)
async def execute_task(request: Request):
    """
    Execute a task with the specified agent
    If the agent session already exists for the task_id, it will be reused

    Data is read directly from request.body
    """
    # Read raw JSON data from request body
    body_bytes = await request.body()
    task_data = json.loads(body_bytes)
    task_id = task_data.get("task_id", -1)
    subtask_id = task_data.get("subtask_id", -1)

    try:
        # Use process function to handle task uniformly
        status = process(task_data)

        # Prepare response
        message = f"Task execution status  : {status.value}"
        
        # Set progress value
        if status == TaskStatus.COMPLETED:
            progress = 100
        elif status == TaskStatus.RUNNING:
            progress = 50  # Task in progress, progress is 50
        else:
            progress = 0
            
        return TaskResponse(
            task_id=task_id,
            subtask_id=subtask_id,
            status=status.value,
            message=message,
            progress=progress,
        )

    except Exception as e:
        logger.exception(f"Error executing task {task_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error executing task: {str(e)}")


@app.delete("/api/tasks/session")
async def delete_session(task_id: str = Query(..., description="Task ID to delete session for")):
    """
    Delete an agent session for a specific task_id
    """
    status, message = agent_service.delete_session(task_id)

    if status == TaskStatus.SUCCESS:
        return {"message": message}
    else:
        raise HTTPException(status_code=404, detail=message)


@app.post("/api/tasks/cancel")
async def cancel_task(
    task_id: int = Query(..., description="Task ID to cancel"),
    background_tasks: BackgroundTasks = None
):
    """
    Cancel the currently running task for a specific task_id
    Returns immediately, callback is sent asynchronously in background to avoid blocking executor_manager's cancel request
    """
    status, message = agent_service.cancel_task(task_id)

    if status == TaskStatus.SUCCESS:
        # Send cancel callback in background without blocking response
        if background_tasks:
            background_tasks.add_task(
                agent_service.send_cancel_callback_async,
                task_id
            )
        return {"message": message}
    else:
        raise HTTPException(status_code=400, detail=message)


@app.get("/api/tasks/sessions")
async def list_sessions():
    """
    List all active agent sessions
    """
    sessions = agent_service.list_sessions()
    return {"total": len(sessions), "sessions": sessions}


@app.delete("/api/tasks/claude/sessions")
async def close_all_claude_sessions():
    """
    Close all Claude client connections
    """
    try:
        status, message = await agent_service.close_all_claude_sessions()
        if status == TaskStatus.SUCCESS:
            return {"message": message}
        else:
            raise HTTPException(status_code=500, detail=message)
    except Exception as e:
        logger.exception(f"Error closing all Claude client connections: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error closing connections: {str(e)}"
        )


@app.delete("/api/tasks/sessions/close")
async def close_all_agent_sessions():
    """
    Close all agent connections regardless of type
    If an agent type doesn't support connection closing, it will be skipped
    """
    try:
        status, message, error_detail = await agent_service.close_all_agent_sessions()
        if status == TaskStatus.SUCCESS:
            return {"message": message}
        else:
            # Return 200 status code even with errors, as some agents may have closed successfully
            return {"message": message, "partial_success": True, "error_detail": error_detail}
    except Exception as e:
        logger.exception(f"Error closing agent connections: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Error closing connections: {str(e)}"
        )


def main():
    """
    Main function for running the FastAPI server
    """
    # Get port from environment variable, default to 10001
    port = int(os.getenv("PORT", 10001))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
