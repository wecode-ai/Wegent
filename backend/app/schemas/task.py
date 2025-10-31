# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum
from typing import Any, Optional, List

from pydantic import BaseModel

from app.schemas.user import UserInDB
from app.schemas.team import TeamInDB
from app.schemas.subtask import SubtaskWithBot

class TaskStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"

class TaskBase(BaseModel):
    """Task base model"""
    title: Optional[str] = None
    type: Optional[str] = None
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
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    prompt: str
    type: Optional[str] = None
    auto_delete_executor: Optional[str] = "false"

class TaskCreateToUser(BaseModel):
    """Task base model"""
    team_name: str
    team_namespace: str
    prompt: str
    title: Optional[str] = None
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    type: Optional[str] = None
    auto_delete_executor: Optional[str] = "false"

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

    class Config:
        from_attributes = True


class TaskListResponse(BaseModel):
    """Task paginated response model"""
    total: int
    items: list[TaskInDB]