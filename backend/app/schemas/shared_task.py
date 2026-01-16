# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel, ConfigDict


class TaskShareInfo(BaseModel):
    """Task share information decoded from token"""

    user_id: int
    user_name: str
    task_id: int
    task_title: str
    task_type: Optional[str] = "chat"  # 'chat' or 'code'
    # Original task's repository information (for code tasks)
    git_repo_id: Optional[int] = None  # Repository ID
    git_repo: Optional[str] = None  # Repository full name (e.g., "owner/repo")
    git_domain: Optional[str] = None  # Git domain (e.g., "github.com")
    git_type: Optional[str] = None  # Git type: "github", "gitlab", "gitee", "gitea"
    branch_name: Optional[str] = None  # Branch name


class TaskShareResponse(BaseModel):
    """Response for task share creation"""

    share_url: str
    share_token: str


class JoinSharedTaskRequest(BaseModel):
    """Request body for joining a shared task"""

    share_token: str
    team_id: Optional[int] = None  # Optional: if not provided, use user's first team
    model_id: Optional[str] = None  # Model name (not database ID)
    force_override_bot_model: Optional[bool] = False
    # Complete git repository fields (for code tasks)
    git_repo_id: Optional[int] = None  # Git repository ID
    git_url: Optional[str] = None  # Git repository URL
    git_repo: Optional[str] = None  # Repository full name (e.g., "owner/repo")
    git_domain: Optional[str] = None  # Git domain (e.g., "github.com")
    branch_name: Optional[str] = None  # Git branch name


class JoinSharedTaskResponse(BaseModel):
    """Response for joining a shared task"""

    message: str
    task_id: int  # The copied task ID for the user


class SharedTaskCreate(BaseModel):
    """Create shared task relationship"""

    user_id: int
    original_user_id: int
    original_task_id: int
    copied_task_id: Optional[int] = None
    is_active: bool = True


class SharedTaskInDB(BaseModel):
    """Shared task model from database"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    original_user_id: int
    original_task_id: int
    copied_task_id: Optional[int] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class PublicContextData(BaseModel):
    """
    Public context data for read-only viewing (unified attachment and knowledge base).
    This replaces the legacy PublicAttachmentData for shared tasks.
    """

    id: int
    context_type: str  # "attachment" or "knowledge_base"
    name: str
    status: str

    # Attachment-specific fields (optional)
    file_extension: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None

    # Knowledge base-specific fields (optional)
    document_count: Optional[int] = None

    class Config:
        from_attributes = True


class PublicSubtaskData(BaseModel):
    """Public subtask data for read-only viewing"""

    id: int
    role: str
    prompt: str
    result: Optional[Any] = None
    status: str
    created_at: datetime
    updated_at: datetime

    # Unified contexts field (replaces attachments)
    contexts: List[PublicContextData] = []

    # Group chat fields
    sender_type: Optional[str] = None
    sender_user_id: Optional[int] = None
    sender_user_name: Optional[str] = None
    reply_to_subtask_id: Optional[int] = None


class PublicSharedTaskResponse(BaseModel):
    """Public response for viewing shared task (no authentication required)"""

    task_title: str
    sharer_name: str
    sharer_id: int
    subtasks: List[PublicSubtaskData]
    created_at: datetime
