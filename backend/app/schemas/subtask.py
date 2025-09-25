# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum
from typing import Any, Optional, List

from pydantic import BaseModel

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
    batch: int = 0
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None

class SubtaskCreate(SubtaskBase):
    """Subtask creation model"""
    pass

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
    executor_deleted_at: Optional[datetime] = None

class SubtaskInDB(SubtaskBase):
    """Database subtask model"""
    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    executor_deleted_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class SubtaskWithBot(SubtaskInDB):
    """Subtask model with bot object instead of bot_id"""
    bot: Optional[dict] = None  # Using dict instead of Bot schema to avoid circular imports
    
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