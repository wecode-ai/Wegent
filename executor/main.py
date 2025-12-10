#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
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
from executor.tasks import process
from executor.services.agent_service import AgentService
from executor.config.config import (
    OTEL_ENABLED,
    OTEL_SERVICE_NAME,
    OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_TRACES_SAMPLER_ARG,
    OTEL_METRICS_ENABLED,
)

# Use the shared logger setup function
logger = setup_logger("task_executor")

# OpenTelemetry imports
TELEMETRY_AVAILABLE = False
try:
    from shared.telemetry import init_telemetry, shutdown_telemetry, is_telemetry_enabled
    from shared.telemetry_metrics import record_task_completed, record_task_failed, record_model_call
    from shared.telemetry_context import (
        set_task_context,
        set_agent_context,
        restore_trace_context_from_env,
    )
    TELEMETRY_AVAILABLE = True
except ImportError:
    logger.debug("OpenTelemetry not available (shared module not found)")

# Define lifespan context manager for startup and shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Run task at startup if TASK_INFO is available
    """
    # Initialize OpenTelemetry if available and enabled
    if TELEMETRY_AVAILABLE and OTEL_ENABLED:
        try:
            init_telemetry(
                service_name=OTEL_SERVICE_NAME,
                enabled=OTEL_ENABLED,
                otlp_endpoint=OTEL_EXPORTER_OTLP_ENDPOINT,
                sampler_ratio=OTEL_TRACES_SAMPLER_ARG,
                service_version="1.0.0",
                metrics_enabled=OTEL_METRICS_ENABLED,
            )
            logger.info("OpenTelemetry initialized successfully")

            # Apply instrumentation
            _setup_opentelemetry_instrumentation(app)

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
    if TELEMETRY_AVAILABLE and OTEL_ENABLED:
        try:
            shutdown_telemetry()
            logger.info("OpenTelemetry shutdown completed")
        except Exception as e:
            logger.warning(f"Error during OpenTelemetry shutdown: {e}")

# Create FastAPI app
app = FastAPI(
    title="Task Executor API",
    description="API for executing tasks with agents",
    lifespan=lifespan
)

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


def _setup_opentelemetry_instrumentation(app: FastAPI) -> None:
    """
    Setup OpenTelemetry instrumentation for the executor service.

    Args:
        app: FastAPI application instance
    """
    try:
        # FastAPI instrumentation
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app)
        logger.info("FastAPI instrumentation enabled")
    except Exception as e:
        logger.warning(f"Failed to setup FastAPI instrumentation: {e}")

    try:
        # HTTPX instrumentation
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        HTTPXClientInstrumentor().instrument()
        logger.info("HTTPX instrumentation enabled")
    except Exception as e:
        logger.warning(f"Failed to setup HTTPX instrumentation: {e}")

    try:
        # Requests instrumentation
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        RequestsInstrumentor().instrument()
        logger.info("Requests instrumentation enabled")
    except Exception as e:
        logger.warning(f"Failed to setup Requests instrumentation: {e}")

    try:
        # System metrics instrumentation
        from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
        SystemMetricsInstrumentor().instrument()
        logger.info("System metrics instrumentation enabled")
    except Exception as e:
        logger.warning(f"Failed to setup System metrics instrumentation: {e}")


if __name__ == "__main__":
    main()
