# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pydantic schemas for E2B-like Sandbox API.

This module defines request and response schemas for the Sandbox REST API,
following the E2B protocol pattern.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# =============================================================================
# Sandbox Schemas
# =============================================================================


class CreateSandboxRequest(BaseModel):
    """Request body for creating a new sandbox.

    Attributes:
        shell_type: Execution environment type (ClaudeCode, Agno)
        user_id: User ID creating the sandbox
        user_name: Username of the creator
        timeout: Sandbox timeout in seconds (default: 1800 = 30 minutes)
        workspace_ref: Optional workspace reference for repository access
        bot_config: Optional bot configuration to pass to executor
        metadata: Optional additional metadata
    """

    shell_type: str = Field(
        ...,
        description="Execution environment type: 'ClaudeCode' or 'Agno'",
        examples=["ClaudeCode"],
    )
    user_id: int = Field(..., description="User ID creating the sandbox")
    user_name: str = Field(default="unknown", description="Username of the creator")
    timeout: int = Field(
        default=1800,
        description="Sandbox timeout in seconds (default: 30 minutes)",
        ge=60,
        le=86400,  # Max 24 hours
    )
    workspace_ref: Optional[str] = Field(
        default=None,
        description="Workspace reference for repository access",
    )
    bot_config: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Bot configuration to pass to executor",
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Additional metadata for the sandbox",
    )


class CreateSandboxResponse(BaseModel):
    """Response body for sandbox creation.

    Attributes:
        sandbox_id: Unique identifier for the created sandbox
        status: Current sandbox status
        container_name: Docker container name
        shell_type: Execution environment type
        created_at: Timestamp when sandbox was created
        expires_at: Timestamp when sandbox will auto-terminate
        message: Optional status message
    """

    sandbox_id: str = Field(..., description="Unique sandbox identifier")
    status: str = Field(..., description="Current sandbox status")
    container_name: str = Field(..., description="Docker container name")
    shell_type: str = Field(..., description="Execution environment type")
    created_at: float = Field(..., description="Creation timestamp")
    expires_at: Optional[float] = Field(None, description="Expiration timestamp")
    message: Optional[str] = Field(None, description="Status message")


class SandboxStatusResponse(BaseModel):
    """Response body for sandbox status query.

    Attributes:
        sandbox_id: Unique sandbox identifier
        status: Current sandbox status
        container_name: Docker container name
        shell_type: Execution environment type
        base_url: Container base URL
        user_id: User ID
        user_name: Username
        created_at: Creation timestamp
        started_at: When sandbox became running
        last_activity_at: Last activity timestamp
        expires_at: Expiration timestamp
        uptime: Sandbox uptime in seconds
        time_remaining: Seconds until expiration
        execution_count: Number of executions in this sandbox
        error_message: Error message if failed
        metadata: Additional metadata
    """

    sandbox_id: str
    status: str
    container_name: str
    shell_type: str
    base_url: Optional[str] = None
    user_id: int
    user_name: str
    created_at: float
    started_at: Optional[float] = None
    last_activity_at: float
    expires_at: Optional[float] = None
    uptime: Optional[float] = None
    time_remaining: Optional[float] = None
    execution_count: int = 0
    error_message: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class TerminateSandboxResponse(BaseModel):
    """Response body for sandbox termination.

    Attributes:
        sandbox_id: Unique sandbox identifier
        status: Current sandbox status (should be 'terminated' or 'terminating')
        message: Status message
    """

    sandbox_id: str
    status: str
    message: str


class KeepAliveRequest(BaseModel):
    """Request body for extending sandbox timeout.

    Attributes:
        timeout: Additional timeout in seconds to add
    """

    timeout: int = Field(
        default=1800,
        description="Additional timeout in seconds (default: 30 minutes)",
        ge=60,
        le=86400,
    )


class KeepAliveResponse(BaseModel):
    """Response body for keep-alive request.

    Attributes:
        sandbox_id: Unique sandbox identifier
        expires_at: New expiration timestamp
        time_remaining: Seconds until expiration
        message: Status message
    """

    sandbox_id: str
    expires_at: float
    time_remaining: float
    message: str


# =============================================================================
# Execution Schemas
# =============================================================================


class ExecuteRequest(BaseModel):
    """Request body for starting an execution in a sandbox.

    Attributes:
        prompt: Task prompt/command to execute
        timeout: Execution timeout in seconds (default: 600 = 10 minutes)
        metadata: Optional additional metadata
    """

    prompt: str = Field(
        ...,
        description="Task prompt to execute",
        min_length=1,
        max_length=1000000,  # 1MB max
    )
    timeout: int = Field(
        default=600,
        description="Execution timeout in seconds (default: 10 minutes)",
        ge=1,
        le=7200,  # Max 2 hours
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Additional metadata for the execution",
    )


class ExecuteResponse(BaseModel):
    """Response body for execution creation.

    Attributes:
        execution_id: Unique execution identifier
        sandbox_id: Parent sandbox ID
        status: Current execution status
        prompt: Task prompt (truncated if long)
        created_at: Creation timestamp
        message: Status message
    """

    execution_id: str
    sandbox_id: str
    status: str
    prompt: str  # May be truncated for response
    created_at: float
    message: str


class ExecutionStatusResponse(BaseModel):
    """Response body for execution status query.

    Attributes:
        execution_id: Unique execution identifier
        sandbox_id: Parent sandbox ID
        status: Current execution status
        prompt: Task prompt (truncated)
        result: Execution result (if completed)
        error_message: Error message (if failed)
        progress: Progress percentage (0-100)
        created_at: Creation timestamp
        started_at: When execution started
        completed_at: When execution completed
        execution_time: Execution time in seconds
        metadata: Additional metadata
    """

    execution_id: str
    sandbox_id: str
    status: str
    prompt: str
    result: Optional[str] = None
    error_message: Optional[str] = None
    progress: int = 0
    created_at: float
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    execution_time: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None


# =============================================================================
# List Schemas
# =============================================================================


class ListExecutionsResponse(BaseModel):
    """Response body for listing executions in a sandbox.

    Attributes:
        executions: List of execution status responses
        sandbox_id: Parent sandbox ID
        total: Total number of executions
    """

    executions: List[ExecutionStatusResponse]
    sandbox_id: str
    total: int


# =============================================================================
# Error Schemas
# =============================================================================


class ErrorResponse(BaseModel):
    """Standard error response.

    Attributes:
        error: Error type/code
        message: Human-readable error message
        details: Optional additional error details
    """

    error: str
    message: str
    details: Optional[Dict[str, Any]] = None
