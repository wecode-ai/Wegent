# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project schemas for API request/response validation.

Projects are containers for organizing tasks. Each task can belong to one project.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ProjectTaskBase(BaseModel):
    """Base model for project-task association."""

    task_id: int = Field(..., description="Task ID to add to project")


class ProjectTaskCreate(ProjectTaskBase):
    """Request model for adding a task to a project."""

    pass


class ProjectTaskResponse(BaseModel):
    """Response model for a task within a project."""

    task_id: int = Field(..., description="Task ID")
    task_title: str = Field(..., description="Task title")
    task_status: str = Field(..., description="Task status")
    is_group_chat: bool = Field(
        default=False, description="Whether the task is a group chat"
    )
    project_id: int = Field(..., description="Project ID")

    class Config:
        from_attributes = True


class ProjectBase(BaseModel):
    """Base model for project data."""

    name: str = Field(..., min_length=1, max_length=100, description="Project name")
    description: str = Field(default="", description="Project description")
    color: Optional[str] = Field(
        None,
        max_length=20,
        description="Project color identifier (e.g., #FF5733)",
    )


class ProjectCreate(ProjectBase):
    """Request model for creating a project."""

    pass


class ProjectUpdate(BaseModel):
    """Request model for updating a project."""

    name: Optional[str] = Field(
        None, min_length=1, max_length=100, description="Project name"
    )
    description: Optional[str] = Field(None, description="Project description")
    color: Optional[str] = Field(None, max_length=20, description="Project color")
    sort_order: Optional[int] = Field(None, description="Sort order for display")
    is_expanded: Optional[bool] = Field(
        None, description="Whether the project is expanded in UI"
    )


class ProjectResponse(ProjectBase):
    """Response model for a project."""

    id: int = Field(..., description="Project ID")
    user_id: int = Field(..., description="Project owner user ID")
    sort_order: int = Field(default=0, description="Sort order for display")
    is_expanded: bool = Field(
        default=True, description="Whether the project is expanded in UI"
    )
    task_count: int = Field(default=0, description="Number of tasks in the project")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        from_attributes = True


class ProjectWithTasksResponse(ProjectResponse):
    """Response model for a project with its tasks."""

    tasks: list[ProjectTaskResponse] = Field(
        default_factory=list,
        description="Tasks in this project",
    )


class ProjectListResponse(BaseModel):
    """Response model for project list with pagination."""

    total: int = Field(..., description="Total number of projects")
    items: list[ProjectWithTasksResponse] = Field(
        default_factory=list,
        description="List of projects",
    )


class AddTaskToProjectResponse(BaseModel):
    """Response model for adding a task to a project."""

    message: str = Field(default="Task added to project successfully")
    project_task: ProjectTaskResponse = Field(
        ..., description="The task that was added to the project"
    )


class RemoveTaskFromProjectResponse(BaseModel):
    """Response model for removing a task from a project."""

    message: str = Field(default="Task removed from project successfully")
