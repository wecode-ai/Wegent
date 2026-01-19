# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pydantic schemas for mem0 API interaction."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class Message(BaseModel):
    """Message model (compatible with mem0 API)."""

    role: str = Field(..., description="Message role (user or assistant)")
    content: str = Field(..., description="Message content")


class MemoryMetadata(BaseModel):
    """Metadata stored with each memory for flexible querying.

    Note: created_at and updated_at are reserved fields in mem0 and cannot be
    stored in metadata. mem0 manages these fields automatically. The default
    timezone for timestamps is US/Pacific.
    """

    task_id: str = Field(..., description="Task ID (for deletion)")
    subtask_id: str = Field(
        ..., description="Subtask ID (message that generated memory)"
    )
    team_id: str = Field(..., description="Team/Agent ID")
    workspace_id: Optional[str] = Field(
        None, description="Workspace ID (for Code tasks)"
    )
    project_id: Optional[str] = Field(
        None, description="Project ID for group conversations"
    )
    is_group_chat: bool = Field(False, description="Individual vs group chat")


class MemoryCreateRequest(BaseModel):
    """Request to create a new memory (compatible with mem0 API)."""

    messages: List[Message] = Field(..., description="Message list")
    user_id: Optional[str] = Field(None, description="User ID (mem0 identifier)")
    agent_id: Optional[str] = Field(None, description="Agent ID (not used)")
    run_id: Optional[str] = Field(None, description="Run ID (not used)")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Custom metadata")


class MemorySearchRequest(BaseModel):
    """Request to search memories (compatible with mem0 API)."""

    query: str = Field(..., description="Search query text")
    user_id: Optional[str] = Field(None, description="User ID filter")
    agent_id: Optional[str] = Field(None, description="Agent ID filter (not used)")
    run_id: Optional[str] = Field(None, description="Run ID filter (not used)")
    filters: Optional[Dict[str, Any]] = Field(None, description="Metadata filters")
    limit: Optional[int] = Field(None, description="Max results")


class MemorySearchResult(BaseModel):
    """Single memory search result.

    Note: created_at is a reserved field managed by mem0 and is returned
    at the top level (not in metadata). It uses US/Pacific timezone by default.
    """

    id: str = Field(..., description="Memory ID")
    memory: str = Field(..., description="Memory content")
    metadata: Dict[str, Any] = Field(
        default_factory=dict, description="Memory metadata"
    )
    score: Optional[float] = Field(None, description="Relevance score")
    created_at: Optional[str] = Field(None, description="Timestamp (US/Pacific)")


class MemorySearchResponse(BaseModel):
    """Response from memory search."""

    results: List[MemorySearchResult] = Field(
        default_factory=list, description="Search results"
    )
