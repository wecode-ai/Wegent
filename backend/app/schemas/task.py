# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum
from typing import Any, List, Optional

from pydantic import BaseModel

from app.schemas.subtask import SubtaskWithBot
from app.schemas.team import TeamInDB
from app.schemas.user import UserInDB


class TaskApp(BaseModel):
    """App preview information (set by expose_service tool when service starts)"""

    name: str
    address: str
    previewUrl: str


class TaskStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    CANCELLING = "CANCELLING"
    DELETE = "DELETE"
    PENDING_CONFIRMATION = "PENDING_CONFIRMATION"  # Pipeline stage completed, waiting for user confirmation


class TaskBase(BaseModel):
    """Task base model"""

    title: Optional[str] = None
    type: Optional[str] = None
    task_type: Optional[str] = None
    team_id: Optional[int] = None
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    prompt: str
    status: TaskStatus = TaskStatus.PENDING
    progress: int = 0
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None


class TaskCreate(BaseModel):
    """Task creation model"""

    title: Optional[str] = None
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    team_namespace: Optional[str] = None
    git_url: Optional[str] = ""
    git_repo: Optional[str] = ""
    git_repo_id: Optional[int] = 0
    git_domain: Optional[str] = ""
    branch_name: Optional[str] = ""
    prompt: str
    type: Optional[str] = "online"  # online、offline
    task_type: Optional[str] = "chat"  # chat、code
    auto_delete_executor: Optional[str] = "false"  # true、fasle
    source: Optional[str] = "web"
    # Model selection fields
    model_id: Optional[str] = None  # Model name (not database ID)
    force_override_bot_model: Optional[bool] = False
    force_override_bot_model_type: Optional[str] = (
        None  # Model type: 'public', 'user', 'group'
    )
    # API key name field
    api_key_name: Optional[str] = None  # API key name used for this request


class TaskUpdate(BaseModel):
    """Task update model"""

    title: Optional[str] = None
    prompt: Optional[str] = None
    status: Optional[TaskStatus] = None
    progress: Optional[int] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
    git_url: Optional[str] = None
    git_repo_id: Optional[int] = None


class TaskExcecutorUpdate(BaseModel):
    """Task update model"""

    task_id: int
    title: Optional[str] = None
    status: Optional[TaskStatus] = None
    progress: Optional[int] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None


class TaskInDB(TaskBase):
    """Database task model"""

    id: int
    user_id: int
    user_name: str
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    is_group_chat: bool = False  # Whether this is a group chat task

    class Config:
        from_attributes = True


class TaskDetail(BaseModel):
    """Detailed task model with related entities"""

    id: int
    title: str
    git_url: str
    git_repo: str
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: str
    prompt: str
    status: TaskStatus = TaskStatus.PENDING
    progress: int = 0
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    user: Optional[UserInDB] = None
    team: Optional[TeamInDB] = None
    subtasks: Any = None
    model_id: Optional[str] = None
    is_group_chat: bool = False  # Whether this is a group chat task
    is_group_owner: bool = False  # Whether current user is the owner (for group chats)
    member_count: Optional[int] = None  # Number of members (for group chats)
    app: Optional[TaskApp] = (
        None  # App preview information (set by expose_service tool)
    )

    class Config:
        from_attributes = True


class TaskListResponse(BaseModel):
    """Task paginated response model"""

    total: int
    items: list[TaskInDB]


class TaskLite(BaseModel):
    """Lightweight task model for list display"""

    id: int
    title: str
    status: TaskStatus
    task_type: str
    type: str
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    team_id: Optional[int] = None
    git_repo: Optional[str] = None
    is_group_chat: bool = False  # Whether this is a group chat task
    knowledge_base_id: Optional[int] = (
        None  # Knowledge base ID for knowledge type tasks
    )

    class Config:
        from_attributes = True


class TaskLiteListResponse(BaseModel):
    """Lightweight task paginated response model"""

    total: int
    items: list[TaskLite]


class ConfirmStageRequest(BaseModel):
    """Request body for confirming a pipeline stage"""

    confirmed_prompt: str  # The edited/confirmed prompt to pass to next stage
    action: str = (
        "continue"  # "continue" to proceed to next stage, "retry" to stay at current stage
    )


class ConfirmStageResponse(BaseModel):
    """Response for confirm stage operation"""

    message: str
    task_id: int
    current_stage: int  # 0-indexed current pipeline stage
    total_stages: int  # Total number of pipeline stages
    next_stage_name: Optional[str] = None  # Name of the next stage (bot name)


class PipelineStageInfo(BaseModel):
    """Information about pipeline stages for a task"""

    current_stage: int  # 0-indexed current pipeline stage
    total_stages: int  # Total number of pipeline stages
    current_stage_name: str  # Name of current stage (bot name)
    is_pending_confirmation: bool  # Whether waiting for user confirmation
    stages: list[dict]  # List of {index, name, require_confirmation, status}
