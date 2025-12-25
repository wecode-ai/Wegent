#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""Code Tool router for executing code tasks in Code Tool mode."""

import asyncio
import json
import os
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from shared.logger import setup_logger
from shared.status import TaskStatus

logger = setup_logger("code_tool_router")

router = APIRouter()


class CodeToolInternalRequest(BaseModel):
    """Internal request model for Code Tool execution."""

    session_id: str = Field(..., description="Chat session ID")
    request_id: str = Field(..., description="Unique request ID")
    prompt: str = Field(..., description="Full prompt including context")
    system_prompt: Optional[str] = Field(None, description="System prompt")
    input_files: Optional[list[str]] = Field(
        None, description="List of input file paths in container"
    )
    timeout: int = Field(default=300, description="Execution timeout")


@dataclass
class StreamEvent:
    """Stream event for SSE responses."""

    event_type: str
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)

    def json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(
            {
                "event_type": self.event_type,
                "data": self.data,
                "timestamp": self.timestamp.isoformat(),
            }
        )


# Fixed model configuration for Code Tool
def _get_fixed_model_config() -> dict[str, Any]:
    """Get fixed model configuration for Code Tool."""
    return {
        "provider": os.getenv("CODE_TOOL_MODEL_PROVIDER", "anthropic"),
        "model": os.getenv("CODE_TOOL_MODEL_NAME", "claude-sonnet-4-20250514"),
        "apiKey": os.getenv("ANTHROPIC_API_KEY", ""),
    }


def _build_task_data(request: CodeToolInternalRequest) -> dict[str, Any]:
    """Build task data for Claude Code Agent."""
    model_config = _get_fixed_model_config()

    # Generate numeric task_id from session_id
    task_id = hash(request.session_id) % 1000000
    subtask_id = hash(request.request_id) % 1000000

    return {
        "task_id": task_id,
        "subtask_id": subtask_id,
        "prompt": request.prompt,
        "bot": [
            {
                "shell_type": "claudecode",
                "system_prompt": request.system_prompt or "",
                "agent_config": {
                    "env": {
                        "model": True,
                        "model_id": model_config["model"],
                        "api_key": model_config["apiKey"],
                    }
                },
                "mcp_servers": {},
                "skills": [],
            }
        ],
        # No git_url - skip git clone
        "git_url": None,
        "type": "code-tool",
        "user": {
            "id": 0,
            "name": "code-tool-user",
        },
    }


async def _execute_code_tool(
    request: CodeToolInternalRequest,
) -> AsyncGenerator[StreamEvent, None]:
    """Execute Code Tool request and yield stream events."""
    from executor.services.agent_service import AgentService

    start_time = time.time()
    task_data = _build_task_data(request)

    logger.info(
        f"Code tool execution started: session={request.session_id}, "
        f"request={request.request_id}"
    )

    yield StreamEvent(
        event_type="progress",
        data={"message": "Initializing Claude Code Agent", "progress": 10},
    )

    try:
        agent_service = AgentService()

        # Create agent
        agent = agent_service.create_agent(task_data)
        if not agent:
            yield StreamEvent(
                event_type="error",
                data={"message": "Failed to create agent", "code": "AGENT_CREATION_FAILED"},
            )
            return

        yield StreamEvent(
            event_type="progress",
            data={"message": "Agent created, preparing execution", "progress": 30},
        )

        # Pre-execute (skip git clone in code-tool mode)
        yield StreamEvent(
            event_type="progress",
            data={"message": "Starting execution", "progress": 50},
        )

        # Execute the task
        # Note: This is synchronous execution, we'll need to make it async
        # For now, run in thread pool
        def run_execution():
            return agent_service.execute_agent_task(agent)

        loop = asyncio.get_event_loop()
        status, error_message = await loop.run_in_executor(None, run_execution)

        # Collect results from agent
        result_content = ""
        thinking_steps = []

        if hasattr(agent, "state_manager") and agent.state_manager:
            workbench = agent.state_manager.get_workbench()
            if workbench:
                result_content = workbench.get("value", "")
                thinking_steps = workbench.get("thinking", [])

        # Emit thinking steps
        for step in thinking_steps:
            yield StreamEvent(
                event_type="thinking",
                data={
                    "title": step.get("title", ""),
                    "content": step.get("action", ""),
                },
            )

        # Emit result
        if status == TaskStatus.COMPLETED or status == TaskStatus.SUCCESS:
            yield StreamEvent(
                event_type="text",
                data={"content": result_content or "Task completed successfully."},
            )

            # Check for output files
            output_dir = "/workspace/output"
            if os.path.exists(output_dir):
                for filename in os.listdir(output_dir):
                    filepath = os.path.join(output_dir, filename)
                    if os.path.isfile(filepath):
                        stat = os.stat(filepath)
                        yield StreamEvent(
                            event_type="file_created",
                            data={
                                "filename": filename,
                                "path": filepath,
                                "size": stat.st_size,
                                "file_id": filename,  # Use filename as file_id
                            },
                        )

            yield StreamEvent(
                event_type="done",
                data={
                    "execution_time": time.time() - start_time,
                    "success": True,
                },
            )
        else:
            yield StreamEvent(
                event_type="error",
                data={
                    "message": error_message or "Execution failed",
                    "code": "EXECUTION_FAILED",
                },
            )

    except asyncio.CancelledError:
        logger.warning(f"Code tool execution cancelled: {request.request_id}")
        yield StreamEvent(
            event_type="error",
            data={"message": "Execution cancelled", "code": "CANCELLED"},
        )
    except Exception as e:
        logger.exception(f"Code tool execution error: {e}")
        yield StreamEvent(
            event_type="error",
            data={"message": str(e), "code": "INTERNAL_ERROR"},
        )


@router.post("/api/code-tool/execute")
async def execute_code_tool(request: CodeToolInternalRequest):
    """
    Execute Code Tool in container.

    This endpoint is called by executor_manager when in code-tool mode.
    It reuses the Claude Code Agent with a fixed model configuration.
    """
    logger.info(
        f"Received code tool request: session={request.session_id}, "
        f"prompt_len={len(request.prompt)}"
    )

    async def event_stream():
        async for event in _execute_code_tool(request):
            yield f"data: {event.json()}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "mode": "code-tool"}
