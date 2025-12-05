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


class PublicAttachmentData(BaseModel):
    """Public attachment data for read-only viewing"""

    id: int
    original_filename: str
    file_extension: str
    file_size: int
    mime_type: str
    extracted_text: str
    text_length: int
    status: str


class PublicSubtaskData(BaseModel):
    """Public subtask data for read-only viewing"""

    id: int
    role: str
    prompt: str
    result: Optional[Any] = None
    status: str
    created_at: datetime
    updated_at: datetime
    attachments: List[PublicAttachmentData] = []


class PublicSharedTaskResponse(BaseModel):
    """Public response for viewing shared task (no authentication required)"""

    task_title: str
    sharer_name: str
    sharer_id: int
    subtasks: List[PublicSubtaskData]
    created_at: datetime

