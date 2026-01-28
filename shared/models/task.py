# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class User(BaseModel):
    id: Optional[int] = None
    name: Optional[str] = None
    git_domain: Optional[str] = None
    git_token: Optional[str] = None
    git_id: Optional[str] = None  # Git user ID
    git_login: Optional[str] = None  # Git username/login
    git_email: Optional[str] = None  # Git email
    user_name: Optional[str] = None  # User display name


class Attachment(BaseModel):
    """Attachment model for executor.

    Note: download_url and image_base64 are intentionally not included.
    The executor constructs download URLs using TASK_API_DOMAIN env var,
    and reads image data from downloaded files to avoid large task payloads.
    """

    id: int
    original_filename: str
    file_extension: str
    file_size: int
    mime_type: str


class Bot(BaseModel):
    id: int
    name: str
    shell_type: Optional[str] = None  # Shell type (e.g., "ClaudeCode", "Agno")
    agent_name: Optional[str] = None  # Legacy field, use shell_type instead
    agent_config: Optional[Dict[str, Any]] = None
    system_prompt: Optional[str] = None
    mcp_servers: Optional[Dict[str, Any]] = None
    skills: Optional[List[str]] = None  # List of skill names
    role: Optional[str] = None  # Bot's role in the team
    base_image: Optional[str] = None  # Custom base image for executor


class Task(BaseModel):
    subtask_id: int
    subtask_next_id: Optional[int] = None
    task_id: int
    subtask_title: Optional[str] = None
    task_title: Optional[str] = None
    user: User
    bot: List[Bot] = []  # List of bots for this task (supports multi-bot teams)
    team_id: int
    team_namespace: Optional[str] = None  # Team namespace for skill lookup
    mode: Optional[str] = None  # Collaboration mode (e.g., "coordinate", "collaborate")
    git_domain: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    branch_name: Optional[str] = None
    git_url: Optional[str] = None
    prompt: Optional[str] = None
    status: Optional[str] = None
    progress: Optional[int] = None
    attachments: List[Attachment] = []  # Attachments for this subtask
    auth_token: Optional[str] = None  # JWT token for authenticated API calls
    type: Optional[str] = None  # Task type: "online" or "offline"
    executor_name: Optional[str] = None  # Executor name for tracking
    executor_namespace: Optional[str] = None  # Executor namespace
    new_session: Optional[bool] = (
        None  # Flag to start new session (no conversation history)
    )
    created_at: Optional[str] = None  # ISO format datetime
    updated_at: Optional[str] = None  # ISO format datetime


class ToolMetadata(BaseModel):
    """Tool execution metadata for enhanced frontend display"""

    # Timing information
    started_at: Optional[str] = Field(
        default=None, description="ISO timestamp when tool started"
    )
    completed_at: Optional[str] = Field(
        default=None, description="ISO timestamp when tool completed"
    )
    duration_ms: Optional[int] = Field(
        default=None, description="Tool execution duration in milliseconds"
    )

    # File-related metadata (for Read/Write/Edit/Glob/Grep tools)
    file_path: Optional[str] = Field(
        default=None, description="File path being operated on"
    )
    file_name: Optional[str] = Field(
        default=None, description="File name extracted from path"
    )
    line_count: Optional[int] = Field(
        default=None, description="Number of lines in file/output"
    )
    file_size: Optional[int] = Field(default=None, description="File size in bytes")
    match_count: Optional[int] = Field(
        default=None, description="Number of matches for search tools"
    )

    # Command-related metadata (for Bash tool)
    command_description: Optional[str] = Field(
        default=None, description="Human-readable command description"
    )
    exit_code: Optional[int] = Field(default=None, description="Command exit code")

    # Web-related metadata (for WebFetch/WebSearch tools)
    url: Optional[str] = Field(default=None, description="URL being fetched/searched")
    result_count: Optional[int] = Field(
        default=None, description="Number of search results"
    )

    # Task-related metadata (for Task tool)
    subagent_type: Optional[str] = Field(default=None, description="Sub-agent type")
    task_description: Optional[str] = Field(
        default=None, description="Task description"
    )

    # Content truncation info
    is_truncated: Optional[bool] = Field(
        default=None, description="Whether output was truncated"
    )
    original_length: Optional[int] = Field(
        default=None, description="Original content length before truncation"
    )

    class Config:
        extra = "allow"


class ToolDetails(BaseModel):
    """Enhanced tool details with structured input/output"""

    type: str = Field(..., description="Type: tool_use, tool_result, system, etc.")
    tool_name: Optional[str] = Field(default=None, description="Tool name")
    status: Optional[str] = Field(
        default=None, description="Status: start, result, error"
    )

    # Structured input/output
    input: Optional[Dict[str, Any]] = Field(
        default=None, description="Tool input parameters"
    )
    output: Optional[str] = Field(default=None, description="Tool output content")
    is_error: Optional[bool] = Field(
        default=False, description="Whether tool execution failed"
    )
    error_message: Optional[str] = Field(
        default=None, description="Error message if failed"
    )

    # Enhanced metadata
    metadata: Optional[ToolMetadata] = Field(
        default=None, description="Tool-specific metadata"
    )

    # For assistant/user message types (keep existing structure)
    message: Optional[Dict[str, Any]] = Field(
        default=None, description="Message content for assistant/user types"
    )

    # Allow additional fields for backward compatibility
    class Config:
        extra = "allow"


class ThinkingStep(BaseModel):
    """Enhanced thinking step with tool metadata support"""

    title: str = Field(..., description="Title of thinking step")
    next_action: str = Field(
        default="continue", description="Next action: continue or complete"
    )
    details: Optional[Dict[str, Any]] = Field(
        default=None, description="Structured tool details"
    )

    # New fields for enhanced display
    step_id: Optional[str] = Field(default=None, description="Unique step identifier")
    tool_use_id: Optional[str] = Field(
        default=None, description="Claude tool_use block ID for correlation"
    )
    timestamp: Optional[str] = Field(
        default=None, description="ISO timestamp for ordering"
    )

    def dict(self, **kwargs) -> Dict[str, Any]:
        """Override dict method to exclude None values"""
        # Exclude None values by default
        kwargs.setdefault("exclude_none", True)
        return super().dict(**kwargs)


class ExecutionResult(BaseModel):
    value: Optional[str] = None
    thinking: List[ThinkingStep] = []
    reasoning_content: Optional[str] = None  # Reasoning content from DeepSeek R1 etc.

    def dict(self, **kwargs) -> Dict[str, Any]:
        """Override dict method to exclude None values"""
        # Exclude None values by default
        kwargs.setdefault("exclude_none", True)
        return super().dict(**kwargs)


class TasksRequest(BaseModel):
    tasks: List[Task]
