# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Streaming event schemas for executor streaming output.

This module defines the schemas for streaming events sent from
executors (Claude Code, Agno) through executor manager to backend.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class StreamingEventType(str, Enum):
    """Streaming event types for executor streaming"""

    STREAM_START = "stream_start"
    STREAM_CHUNK = "stream_chunk"
    TOOL_START = "tool_start"
    TOOL_DONE = "tool_done"
    STREAM_DONE = "stream_done"
    STREAM_ERROR = "stream_error"


class StreamingEventRequest(BaseModel):
    """
    Request schema for streaming events from executor manager.

    This is the unified schema for all streaming event types.
    Different fields are populated based on event_type.
    """

    event_type: StreamingEventType = Field(..., description="Type of streaming event")
    timestamp: datetime = Field(
        default_factory=datetime.now,
        description="Timestamp when the event was generated",
    )

    # For stream_start
    shell_type: Optional[str] = Field(
        None, description="Shell type (ClaudeCode, Agno, etc.)"
    )

    # For stream_chunk
    content: Optional[str] = Field(None, description="Incremental content chunk")
    offset: Optional[int] = Field(
        None, description="Character offset in the full response"
    )

    # For tool events (tool_start, tool_done)
    tool_id: Optional[str] = Field(None, description="Unique tool execution ID")
    tool_name: Optional[str] = Field(
        None, description="Name of the tool being executed"
    )
    tool_input: Optional[Dict[str, Any]] = Field(
        None, description="Input parameters for the tool"
    )
    tool_output: Optional[str] = Field(None, description="Output from tool execution")
    tool_error: Optional[str] = Field(None, description="Error message if tool failed")

    # For stream_done and stream_chunk with result
    result: Optional[Dict[str, Any]] = Field(
        None,
        description="Result data containing value, thinking, workbench, etc.",
    )

    # For stream_error
    error: Optional[str] = Field(
        None, description="Error message for stream_error event"
    )

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat(),
        }


class StreamingEventResponse(BaseModel):
    """Response schema for streaming event handling"""

    success: bool = Field(
        ..., description="Whether the event was processed successfully"
    )
    message: str = Field(default="", description="Optional message")
    task_id: Optional[int] = Field(None, description="Task ID")
    subtask_id: Optional[int] = Field(None, description="Subtask ID")


class StreamingStateData(BaseModel):
    """
    Data model for streaming state stored in Redis.

    This tracks the current state of a streaming session for
    reconnection support and state recovery.
    """

    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    shell_type: str = Field(..., description="Shell type (ClaudeCode, Agno)")
    status: str = Field(
        default="streaming", description="Current status (streaming, completed, error)"
    )
    started_at: datetime = Field(
        default_factory=datetime.now, description="When streaming started"
    )
    last_update_at: datetime = Field(
        default_factory=datetime.now, description="Last update time"
    )
    content_length: int = Field(
        default=0, description="Current accumulated content length"
    )
    offset: int = Field(default=0, description="Current offset")
    thinking_count: int = Field(default=0, description="Number of thinking steps")
    last_db_save_at: Optional[datetime] = Field(
        None, description="Last time content was saved to database"
    )

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat(),
        }


class StreamingStatusResponse(BaseModel):
    """Response schema for getting streaming status"""

    is_streaming: bool = Field(..., description="Whether streaming is active")
    subtask_id: Optional[int] = Field(None, description="Subtask ID if streaming")
    shell_type: Optional[str] = Field(None, description="Shell type if streaming")
    started_at: Optional[datetime] = Field(None, description="When streaming started")
    current_content_length: Optional[int] = Field(
        None, description="Current content length"
    )
