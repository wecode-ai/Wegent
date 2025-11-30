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
from executor.callback.startup_reporter import check_startup_allowed

# Use the shared logger setup function
logger = setup_logger("task_executor")

# Define lifespan context manager for startup and shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Run task at startup if TASK_INFO is available.
    Checks restart limit before execution.
    """
    try:
        if os.getenv("TASK_INFO"):
            logger.info("TASK_INFO environment variable found, checking startup allowed")

            # Check if restart is allowed before executing task
            allowed, startup_result = check_startup_allowed()
            if not allowed:
                logger.error(
                    f"Executor startup not allowed: {startup_result.get('message', 'Restart limit exceeded')}. "
                    f"Restart count: {startup_result.get('restart_count', 0)}/{startup_result.get('max_restart', 0)}"
                )
                # Exit with non-zero code to indicate failure
                logger.info("Exiting executor due to restart limit exceeded")
                os._exit(1)

            logger.info(
                f"Startup allowed: restart_count={startup_result.get('restart_count', 0)}/"
                f"{startup_result.get('max_restart', 0)}, proceeding with task execution"
            )

            status = run_task()
            logger.info(f"Task execution status: {status}")
        else:
            logger.info(
                "No TASK_INFO environment variable found, skipping task execution"
            )
    except Exception as e:
        logger.exception(f"Error running task at startup: {str(e)}")

    yield  # Application runs here

    # Shutdown logic can be added here if needed

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


if __name__ == "__main__":
    main()
