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


class ThinkingStep(BaseModel):
    """Thinking step model for recording agent reasoning process"""

    title: str = Field(..., description="Title of thinking step")
    next_action: str = Field(default="continue", description="Next action to take")
    details: Optional[Dict[str, Any]] = Field(
        default=None, description="Detailed structured data for this step"
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
