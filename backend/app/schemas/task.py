# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum
from typing import Any, List, Optional

from pydantic import BaseModel, model_validator

from app.core.constants import CLIENT_ORIGIN_FRONTEND, SUPPORTED_CLIENT_ORIGINS
from app.schemas.kind import SkillRefMeta
from app.schemas.subtask import SubtaskWithBot
from app.schemas.team import TeamInDB
from app.schemas.user import UserInDB


class SkillRef(BaseModel):
    """Skill reference with full identification info.

    Backend needs name + namespace + is_public to uniquely identify a skill.
    """

    name: str
    namespace: str
    is_public: bool


class TaskApp(BaseModel):
    """App preview information (set by expose_service tool when service starts)"""

    name: str
    address: str
    previewUrl: str


class TaskStatus(str, Enum):
    """Enum for task execution status."""

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
    client_origin: str = CLIENT_ORIGIN_FRONTEND
    project_id: Optional[int] = 0
    # Model selection fields
    model_id: Optional[str] = None  # Model name (not database ID)
    force_override_bot_model: Optional[bool] = False
    force_override_bot_model_type: Optional[str] = (
        None  # Model type: 'public', 'user', 'group'
    )
    model_options: Optional[dict[str, Any]] = None
    # API key name field
    api_key_name: Optional[str] = None  # API key name used for this request

    # Skill selection (user-selected skills for this message)
    # Backend determines preload vs download based on executor type
    additional_skills: Optional[List[SkillRef]] = None

    @model_validator(mode="after")
    def default_model_selection_to_override(self) -> "TaskCreate":
        """Treat an explicit model_id as an override selection."""
        if self.model_id:
            self.force_override_bot_model = True
        if self.client_origin not in SUPPORTED_CLIENT_ORIGINS:
            raise ValueError("Unsupported client_origin")
        return self


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
    project_id: int = 0
    client_origin: str = CLIENT_ORIGIN_FRONTEND
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    is_group_chat: bool = False  # Whether this is a group chat task
    preserve_executor: bool = (
        False  # Whether to preserve executor pod after task completion
    )
    execution_workspace_source: Optional[str] = None

    class Config:
        """Pydantic config."""

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
    task_type: str = "chat"  # Task type: 'chat', 'code', 'knowledge', 'task'
    project_id: int = 0
    client_origin: str = CLIENT_ORIGIN_FRONTEND
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
    force_override_bot_model_type: Optional[str] = None
    model_options: Optional[dict[str, Any]] = None
    is_group_chat: bool = False  # Whether this is a group chat task
    is_group_owner: bool = False  # Whether current user is the owner (for group chats)
    member_count: Optional[int] = None  # Number of members (for group chats)
    app: Optional[TaskApp] = (
        None  # App preview information (set by expose_service tool)
    )
    device_id: Optional[str] = None  # Device ID used for execution (for task history)
    execution_workspace_source: Optional[str] = None
    preserve_executor: bool = (
        False  # Whether to preserve executor pod after task completion
    )
    requested_skills: Optional[List[SkillRef]] = (
        None  # User-selected skills for this task
    )

    class Config:
        """Pydantic config."""

        from_attributes = True


class TaskRuntimeActiveStream(BaseModel):
    """Lightweight active stream checkpoint for runtime consistency checks."""

    subtask_id: int
    cursor: int = 0
    last_activity_at: Optional[datetime] = None


class TaskRuntimeCheck(BaseModel):
    """Lightweight task runtime checkpoint.

    Message content is intentionally excluded and recovered through WebSocket
    join/resume only.
    """

    task_id: int
    task_status: TaskStatus
    status_updated_at: Optional[datetime] = None
    active_stream: Optional[TaskRuntimeActiveStream] = None


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
    team_name: Optional[str] = None
    team_namespace: Optional[str] = None
    team_display_name: Optional[str] = None
    team_icon: Optional[str] = None
    project_id: int = 0
    client_origin: str = CLIENT_ORIGIN_FRONTEND
    device_id: Optional[str] = None
    device_name: Optional[str] = None
    execution_workspace_source: Optional[str] = None
    git_repo: Optional[str] = None
    is_group_chat: bool = False  # Whether this is a group chat task
    knowledge_base_id: Optional[int] = (
        None  # Knowledge base ID for knowledge type tasks
    )

    class Config:
        """Pydantic config."""

        from_attributes = True


class TaskLiteListResponse(BaseModel):
    """Lightweight task paginated response model"""

    total: int
    items: list[TaskLite]


class TaskLiteGroup(BaseModel):
    """A current-page task group for lightweight history display."""

    group_type: str
    group_key: str
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    team_namespace: Optional[str] = None
    team_display_name: Optional[str] = None
    team_icon: Optional[str] = None
    device_id: Optional[str] = None
    device_name: Optional[str] = None
    items: list[TaskLite]


class TaskLiteGroupedListResponse(BaseModel):
    """Lightweight grouped task response for current-page history display."""

    total: int
    items: list[TaskLiteGroup]


class ArchivedTask(BaseModel):
    """Archived chat item for settings and restore/delete actions."""

    id: int
    title: str
    status: str
    task_type: str
    type: str
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    project_id: int = 0
    client_origin: str = CLIENT_ORIGIN_FRONTEND
    project_name: Optional[str] = None


class ArchivedTaskListResponse(BaseModel):
    """Archived chat list response."""

    total: int
    items: list[ArchivedTask]


class TaskArchiveResponse(BaseModel):
    """Response for a single archive state transition."""

    message: str
    task_id: int


class TaskArchiveBatchResponse(BaseModel):
    """Response for batch archive/delete operations."""

    message: str
    count: int


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


class TaskSkillsResponse(BaseModel):
    """Response for GET /tasks/{task_id}/skills endpoint.

    Returns all skills associated with a task through the chain:
    task → team → bots → ghosts → skills
    """

    task_id: int
    team_id: Optional[int] = None
    team_namespace: str = "default"
    skills: List[str] = []  # All bot skills (deduplicated)
    preload_skills: List[str] = []  # Skills to preload
    skill_refs: dict[str, SkillRefMeta] = {}
    preload_skill_refs: dict[str, SkillRefMeta] = {}


class PromptDraftGenerateRequest(BaseModel):
    """Request body for generating a prompt draft from a task conversation."""

    model: Optional[str] = None
    source: Optional[str] = None
    current_prompt: Optional[str] = None
    regenerate: bool = False


class PromptDraftGenerateResponse(BaseModel):
    """Response body for prompt draft generation."""

    title: str
    prompt: str
    model: str
    version: int = 1
    created_at: datetime
