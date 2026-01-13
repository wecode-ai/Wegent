# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chunk callback models for incremental executor callbacks.

This module defines data structures for incremental (chunk) mode callbacks,
reducing performance and network overhead compared to full result callbacks.
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ChunkType(str, Enum):
    """Types of incremental chunk data."""

    CHUNK = "chunk"  # Text content increment
    THINKING = "thinking"  # Reasoning step / tool use
    REASONING = "reasoning"  # DeepSeek R1 reasoning content increment
    WORKBENCH_DELTA = "workbench_delta"  # Workbench state delta/patch
    STATUS = "status"  # Status update (compatible with existing)


class ContentChunk(BaseModel):
    """Text content increment.

    Similar to OpenAI v1/responses chunk mode.
    """

    type: str = Field(default=ChunkType.CHUNK.value, description="Chunk type")
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    content: str = Field(..., description="Incremental text content")
    offset: int = Field(..., description="Current character offset position")
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


class ThinkingStepDetails(BaseModel):
    """Details for a thinking step."""

    type: Optional[str] = Field(default=None, description="tool_use, tool_result, etc.")
    status: Optional[str] = Field(
        default=None, description="running, completed, failed"
    )
    tool_name: Optional[str] = Field(default=None, description="Name of the tool")
    input: Optional[Dict[str, Any]] = Field(default=None, description="Tool input")
    output: Optional[Any] = Field(default=None, description="Tool output")


class ThinkingStepData(BaseModel):
    """Thinking step data structure."""

    title: str = Field(..., description="Step title (for i18n)")
    tool_name: Optional[str] = Field(default=None, description="Tool name if applicable")
    status: str = Field(
        default="running", description="Step status: running|completed|failed"
    )
    details: Optional[ThinkingStepDetails] = Field(
        default=None, description="Detailed structured data"
    )
    run_id: Optional[str] = Field(
        default=None, description="Run ID for matching tool_use/tool_result pairs"
    )


class ThinkingChunk(BaseModel):
    """Thinking step increment.

    Similar to OpenAI v1/responses tool_use mode.
    """

    type: str = Field(default=ChunkType.THINKING.value, description="Chunk type")
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    step: ThinkingStepData = Field(..., description="Thinking step data")
    step_index: int = Field(..., description="Step index for update/append")
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


class ReasoningChunk(BaseModel):
    """Reasoning content increment (DeepSeek R1).

    Separate from main content for extended thinking display.
    """

    type: str = Field(default=ChunkType.REASONING.value, description="Chunk type")
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    content: str = Field(..., description="Incremental reasoning content")
    offset: int = Field(..., description="Current character offset")
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


class FileChange(BaseModel):
    """File change in workbench delta."""

    path: str = Field(..., description="File path")
    added_lines: Optional[int] = Field(default=None, description="Lines added")
    removed_lines: Optional[int] = Field(default=None, description="Lines removed")
    status: Optional[str] = Field(
        default=None, description="added, modified, deleted"
    )


class GitCommit(BaseModel):
    """Git commit info in workbench delta."""

    commit_id: str = Field(..., description="Commit SHA")
    message: str = Field(..., description="Commit message")
    timestamp: Optional[str] = Field(default=None, description="Commit timestamp")


class WorkbenchDeltaData(BaseModel):
    """Delta/Patch data for workbench changes.

    Only sends changed fields rather than full workbench state.
    """

    file_changes: Optional[Dict[str, List[FileChange]]] = Field(
        default=None, description="File changes: add/remove lists"
    )
    git_info: Optional[Dict[str, Any]] = Field(
        default=None, description="Git info delta: task_commits, etc."
    )
    status: Optional[str] = Field(
        default=None, description="Direct status override if changed"
    )
    error: Optional[str] = Field(default=None, description="Error message if any")


class WorkbenchDeltaChunk(BaseModel):
    """Workbench state delta increment.

    Uses delta/patch mode - only sends changed fields.
    """

    type: str = Field(default=ChunkType.WORKBENCH_DELTA.value, description="Chunk type")
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    delta: WorkbenchDeltaData = Field(..., description="Delta/patch data")
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


class StatusChunk(BaseModel):
    """Status update chunk (backward compatible).

    Maintains compatibility with existing status update pattern.
    """

    type: str = Field(default=ChunkType.STATUS.value, description="Chunk type")
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    status: str = Field(..., description="Status: RUNNING|COMPLETED|FAILED")
    progress: int = Field(default=0, description="Progress percentage 0-100")
    error_message: Optional[str] = Field(default=None, description="Error message")
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


class ChunkCallbackRequest(BaseModel):
    """Unified chunk callback request model.

    Used by Executor Manager to receive and forward chunk callbacks.
    """

    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    chunk_type: str = Field(
        ..., description="Chunk type: chunk|thinking|reasoning|workbench_delta|status"
    )
    data: Dict[str, Any] = Field(..., description="Chunk data payload")
    executor_name: Optional[str] = Field(default=None, description="Executor name")
    executor_namespace: Optional[str] = Field(
        default=None, description="Executor namespace"
    )
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")
    task_type: Optional[str] = Field(
        default=None, description="Task type: validation, sandbox, or None for regular"
    )
