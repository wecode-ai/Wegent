# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class User(BaseModel):
    id: int
    name: str
    git_domain: Optional[str] = None
    git_token: Optional[str] = None


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
    agent_name: str
    agent_config: Optional[Dict[str, Any]] = None
    system_prompt: Optional[str] = None
    mcp_servers: Optional[Dict[str, Any]] = None


class Task(BaseModel):
    subtask_id: int
    subtask_next_id: Optional[int] = None
    task_id: int
    subtask_title: Optional[str] = None
    task_title: Optional[str] = None
    user: User
    bot: Bot
    team_id: int
    git_domain: str
    git_repo: str
    git_repo_id: int
    branch_name: str
    git_url: str
    prompt: str
    status: str
    progress: int
    attachments: List[Attachment] = []  # Attachments for this subtask
    auth_token: Optional[str] = None  # JWT token for authenticated API calls


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
