# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

# Import the masking utility - using relative import from backend
import sys
from datetime import datetime
from enum import Enum
from typing import Any, List, Optional

from pydantic import BaseModel, Field, field_serializer

# Add the project root to sys.path if not already there
project_root = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from shared.utils.sensitive_data_masker import mask_sensitive_data


class SubtaskStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"


class SubtaskRole(str, Enum):
    USER = "USER"
    ASSISTANT = "ASSISTANT"


class SubtaskBase(BaseModel):
    """Subtask base model"""

    task_id: int
    team_id: int
    title: str
    bot_ids: List[int] = []
    role: SubtaskRole = SubtaskRole.ASSISTANT
    prompt: Optional[str] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    message_id: int = 0
    parent_id: Optional[int] = None
    status: SubtaskStatus = SubtaskStatus.PENDING
    progress: int = 0
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None


class SubtaskCreate(SubtaskBase):
    """Subtask creation model"""

    pass


class SubtaskAttachment(BaseModel):
    """Subtask attachment schema"""

    id: int
    filename: str = Field(validation_alias="original_filename")
    file_size: int
    mime_type: str
    status: str
    file_extension: str
    created_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class SubtaskUpdate(BaseModel):
    """Subtask update model"""

    title: Optional[str] = None
    status: Optional[SubtaskStatus] = None
    progress: Optional[int] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    message_id: Optional[int] = None
    parent_id: Optional[int] = None
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
    executor_deleted_at: Optional[bool] = False


class SubtaskInDB(SubtaskBase):
    """Database subtask model"""

    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    executor_deleted_at: Optional[bool] = False
    attachments: List[SubtaskAttachment] = []

    @field_serializer("result")
    def mask_result(self, value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        """Mask sensitive data in result field before serialization"""
        if value is None:
            return None
        return mask_sensitive_data(value)

    @field_serializer("error_message")
    def mask_error_message(self, value: Optional[str]) -> Optional[str]:
        """Mask sensitive data in error_message field before serialization"""
        if value is None:
            return None
        return mask_sensitive_data(value)

    class Config:
        from_attributes = True


class SubtaskWithBot(SubtaskInDB):
    """Subtask model with bot object instead of bot_id"""

    bot: Optional[dict] = (
        None  # Using dict instead of Bot schema to avoid circular imports
    )

    class Config:
        from_attributes = True


class SubtaskListResponse(BaseModel):
    """Subtask paginated response model"""

    total: int
    items: list[SubtaskInDB]


class SubtaskExecutorUpdate(BaseModel):
    """Executor subtask update model"""

    subtask_id: int
    task_title: Optional[str] = None
    subtask_title: Optional[str] = None
    status: SubtaskStatus
    progress: int = 0
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
