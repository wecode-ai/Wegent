# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SSE (Server-Sent Events) schema definitions for streaming task execution.

These schemas are compatible with Dify Workflow SSE event format.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SSEEventType(str, Enum):
    """SSE event types for task streaming"""

    WORKFLOW_STARTED = "workflow_started"
    NODE_STARTED = "node_started"
    NODE_FINISHED = "node_finished"
    WORKFLOW_FINISHED = "workflow_finished"
    ERROR = "error"
    PING = "ping"


class WorkflowStartedData(BaseModel):
    """Data for workflow_started event"""

    task_id: int
    workflow_run_id: str
    created_at: datetime


class NodeStartedData(BaseModel):
    """Data for node_started event"""

    node_id: str  # subtask_id
    node_type: str = "bot"  # Always "bot" in Wegent context
    title: str
    bot_name: Optional[str] = None
    index: Optional[int] = None  # Node execution order


class NodeFinishedData(BaseModel):
    """Data for node_finished event"""

    node_id: str  # subtask_id
    status: str  # succeeded, failed
    outputs: Optional[Dict[str, Any]] = None
    execution_metadata: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None


class WorkflowFinishedData(BaseModel):
    """Data for workflow_finished event"""

    status: str  # succeeded, failed, cancelled
    outputs: Optional[Dict[str, Any]] = None
    total_tokens: Optional[int] = None
    total_steps: int = 0
    elapsed_time: Optional[float] = None  # in seconds
    error_message: Optional[str] = None


class SSEEvent(BaseModel):
    """Base SSE event structure"""

    event: SSEEventType
    task_id: int
    data: Optional[Dict[str, Any]] = None
    message: Optional[str] = None  # For error events
    created_at: datetime = Field(default_factory=datetime.now)

    def to_sse_format(self) -> str:
        """Convert event to SSE format string"""
        import json

        payload = {
            "event": self.event.value,
            "task_id": self.task_id,
            "created_at": self.created_at.isoformat(),
        }

        if self.data is not None:
            payload["data"] = self.data
        if self.message is not None:
            payload["message"] = self.message

        return f"data: {json.dumps(payload, default=str)}\n\n"


class StreamTaskCreate(BaseModel):
    """Request model for creating a streaming task"""

    team_id: Optional[int] = None
    team_name: Optional[str] = None
    team_namespace: Optional[str] = None
    prompt: str
    title: Optional[str] = None
    type: Optional[str] = "online"  # online, offline
    task_type: Optional[str] = "chat"  # chat, code
    inputs: Optional[Dict[str, Any]] = None  # Additional input parameters

    # Model override fields
    model_id: Optional[str] = None
    force_override_bot_model: Optional[bool] = False

    # Git related fields (optional)
    git_url: Optional[str] = ""
    git_repo: Optional[str] = ""
    git_repo_id: Optional[int] = 0
    git_domain: Optional[str] = ""
    branch_name: Optional[str] = ""


class TeamParameter(BaseModel):
    """Team input parameter definition"""

    name: str
    type: str  # string, select, text, number, etc.
    required: bool = False
    description: Optional[str] = None
    options: Optional[List[str]] = None  # For select type
    default: Optional[Any] = None
    max_length: Optional[int] = None


class TeamParametersResponse(BaseModel):
    """Response for team parameters endpoint"""

    parameters: List[TeamParameter] = []
    has_parameters: bool = False
    app_mode: Optional[str] = None  # For external API teams


class TeamWithWorkflow(BaseModel):
    """Team with workflow information"""

    id: int
    name: str
    workflow_enabled: bool = False
    has_parameters: bool = False
