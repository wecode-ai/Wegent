# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Code Tool schemas for executing code tasks in isolated Docker containers."""

from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class FileAttachment(BaseModel):
    """File attachment model for Code Tool."""

    file_id: str = Field(..., description="Uploaded file ID")
    filename: str = Field(..., description="Original filename")
    size: int = Field(..., description="File size in bytes")
    target_path: Optional[str] = Field(
        None, description="Target path in container, default /workspace/input/{filename}"
    )


class ConversationMessage(BaseModel):
    """Conversation history message."""

    role: Literal["user", "assistant"] = Field(..., description="Message role")
    content: str = Field(..., description="Message content")


class CodeToolExecuteRequest(BaseModel):
    """Code Tool execution request."""

    # Session identifier
    session_id: str = Field(..., description="Chat session ID")

    # Core input
    prompt: str = Field(..., description="Task prompt/description")

    # Optional context
    files: Optional[list[FileAttachment]] = Field(
        None, description="Attached files to be available in container"
    )
    conversation_history: Optional[list[ConversationMessage]] = Field(
        None, description="Previous conversation history for context"
    )
    system_prompt: Optional[str] = Field(
        None, description="Additional system prompt for the agent"
    )

    # Execution configuration
    timeout: int = Field(
        default=300,
        ge=1,
        le=1800,
        description="Execution timeout in seconds (max 30 minutes)",
    )


class ThinkingStep(BaseModel):
    """Thinking step model."""

    title: str = Field(..., description="Step title")
    next_action: str = Field(default="continue", description="Next action indicator")
    details: Optional[dict[str, Any]] = Field(None, description="Additional details")


class OutputFile(BaseModel):
    """Output file model."""

    file_id: str = Field(..., description="File ID for download")
    filename: str = Field(..., description="Filename")
    path: str = Field(..., description="Path in container")
    size: int = Field(..., description="File size in bytes")
    download_url: str = Field(..., description="Download URL")


class CodeToolExecuteResponse(BaseModel):
    """Code Tool final execution response."""

    success: bool = Field(..., description="Whether execution was successful")
    session_id: str = Field(..., description="Session ID")
    container_id: str = Field(..., description="Container ID")

    # Execution results
    result: str = Field(..., description="Agent's final response")
    thinking_steps: list[ThinkingStep] = Field(
        default_factory=list, description="Thinking steps during execution"
    )
    execution_time: float = Field(..., description="Total execution time in seconds")

    # Output files
    output_files: list[OutputFile] = Field(
        default_factory=list, description="Generated output files"
    )

    # Error info
    error: Optional[str] = Field(None, description="Error message if failed")


class StreamEventType(str, Enum):
    """Stream event types."""

    THINKING = "thinking"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"
    TEXT = "text"
    FILE_CREATED = "file_created"
    PROGRESS = "progress"
    DONE = "done"
    ERROR = "error"


class StreamEvent(BaseModel):
    """Stream event model for SSE responses."""

    event_type: StreamEventType = Field(..., description="Event type")
    data: dict[str, Any] = Field(default_factory=dict, description="Event data")
    timestamp: datetime = Field(
        default_factory=datetime.now, description="Event timestamp"
    )


class SessionStatus(BaseModel):
    """Code Tool session status."""

    session_id: str = Field(..., description="Session ID")
    container_id: Optional[str] = Field(None, description="Container ID if running")
    status: Literal["idle", "running", "stopped", "error"] = Field(
        ..., description="Session status"
    )
    created_at: Optional[datetime] = Field(None, description="Session creation time")
    last_active: Optional[datetime] = Field(None, description="Last activity time")
    resource_usage: Optional[dict[str, Any]] = Field(
        None, description="Resource usage info"
    )


class ChunkUploadRequest(BaseModel):
    """Chunk upload request for large files."""

    upload_id: str = Field(..., description="Upload session ID")
    chunk_index: int = Field(..., description="Chunk index (0-based)")
    total_chunks: int = Field(..., description="Total number of chunks")


class ChunkUploadResponse(BaseModel):
    """Chunk upload response."""

    upload_id: str = Field(..., description="Upload session ID")
    chunk_index: int = Field(..., description="Uploaded chunk index")
    total_chunks: int = Field(..., description="Total chunks expected")
    received_chunks: int = Field(..., description="Number of chunks received")
    complete: bool = Field(..., description="Whether upload is complete")


# Internal request model for executor communication
class CodeToolInternalRequest(BaseModel):
    """Internal request model for executor-manager to executor communication."""

    session_id: str = Field(..., description="Chat session ID")
    request_id: str = Field(..., description="Unique request ID")
    prompt: str = Field(..., description="Full prompt including context")
    system_prompt: Optional[str] = Field(None, description="System prompt")
    input_files: Optional[list[str]] = Field(
        None, description="List of input file paths in container"
    )
    timeout: int = Field(default=300, description="Execution timeout")
