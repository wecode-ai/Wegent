# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project API endpoints for managing projects and project-task associations.

Projects are containers for organizing tasks. Each task can belong to one project.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.project import (
    AddTaskToProjectResponse,
    ProjectCreate,
    ProjectListResponse,
    ProjectResponse,
    ProjectTaskCreate,
    ProjectUpdate,
    ProjectWithTasksResponse,
    RemoveTaskFromProjectResponse,
)
from app.services import project_service

router = APIRouter()


@router.get("", response_model=ProjectListResponse)
def list_projects(
    include_tasks: bool = Query(
        True, description="Whether to include tasks in response"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List all projects for the current user.
    Returns projects with optional task lists.
    """
    return project_service.list_projects(
        db=db, user_id=current_user.id, include_tasks=include_tasks
    )


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project_endpoint(
    project_create: ProjectCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new project.
    The current user becomes the project owner.
    """
    try:
        return project_service.create_project(
            db=db, project_data=project_create, user_id=current_user.id
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create project: {str(e)}",
        )


@router.get("/{project_id}", response_model=ProjectWithTasksResponse)
def get_project_endpoint(
    project_id: int = Path(..., description="Project ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get project details by ID with its tasks.
    """
    project = project_service.get_project(
        db=db, project_id=project_id, user_id=current_user.id
    )

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    return project


@router.put("/{project_id}", response_model=ProjectResponse)
def update_project_endpoint(
    project_id: int = Path(..., description="Project ID"),
    project_update: ProjectUpdate = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update project information.
    """
    try:
        return project_service.update_project(
            db=db,
            project_id=project_id,
            update_data=project_update,
            user_id=current_user.id,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update project: {str(e)}",
        )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_endpoint(
    project_id: int = Path(..., description="Project ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete a project (soft delete).
    Tasks are not deleted, only their project_id is set to NULL.
    """
    try:
        project_service.delete_project(
            db=db, project_id=project_id, user_id=current_user.id
        )
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete project: {str(e)}",
        )


# ============================================================================
# Project-Task association routes
# ============================================================================


@router.post(
    "/{project_id}/tasks",
    response_model=AddTaskToProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_task_to_project_endpoint(
    project_id: int = Path(..., description="Project ID"),
    task_data: ProjectTaskCreate = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Add a task to a project.
    """
    try:
        project_task = project_service.add_task_to_project(
            db=db,
            project_id=project_id,
            task_id=task_data.task_id,
            user_id=current_user.id,
        )
        return AddTaskToProjectResponse(
            message="Task added to project successfully",
            project_task=project_task,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to add task to project: {str(e)}",
        )


@router.delete(
    "/{project_id}/tasks/{task_id}",
    response_model=RemoveTaskFromProjectResponse,
)
def remove_task_from_project_endpoint(
    project_id: int = Path(..., description="Project ID"),
    task_id: int = Path(..., description="Task ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove a task from a project.
    The task itself is not deleted, only the project_id is set to NULL.
    """
    try:
        project_service.remove_task_from_project(
            db=db,
            project_id=project_id,
            task_id=task_id,
            user_id=current_user.id,
        )
        return RemoveTaskFromProjectResponse(
            message="Task removed from project successfully"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to remove task from project: {str(e)}",
        )
