# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project API endpoints for managing projects and project-task associations.

Projects are containers for organizing tasks. Each task can belong to one project.
"""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.constants import CLIENT_ORIGIN_FRONTEND, SUPPORTED_CLIENT_ORIGINS
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.project import (
    AddTaskToProjectResponse,
    GitWorkspaceProjectCreate,
    GitWorkspaceProjectResponse,
    ProjectConversationCreate,
    ProjectConversationResponse,
    ProjectCreate,
    ProjectDeviceSessionResponse,
    ProjectListResponse,
    ProjectResponse,
    ProjectTaskCreate,
    ProjectUpdate,
    ProjectWithTasksResponse,
    ProjectWorktreeDeleteResponse,
    ProjectWorktreeListResponse,
    RemoveTaskFromProjectResponse,
)
from app.schemas.task import TaskArchiveBatchResponse
from app.services import project_device_session_service, project_service

router = APIRouter()

ClientOriginQuery = Annotated[
    str,
    Query(
        pattern=f"^({'|'.join(SUPPORTED_CLIENT_ORIGINS)})$",
        description="Client surface to scope projects and project chats",
    ),
]


@router.get("", response_model=ProjectListResponse)
def list_projects(
    include_tasks: bool = Query(
        True, description="Whether to include tasks in response"
    ),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List all projects for the current user.
    Returns projects with optional task lists.
    """
    return project_service.list_projects(
        db=db,
        user_id=current_user.id,
        include_tasks=include_tasks,
        client_origin=client_origin,
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


@router.post(
    "/git-workspace",
    response_model=GitWorkspaceProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_git_workspace_project_endpoint(
    project_create: GitWorkspaceProjectCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a Git-backed workspace project and clone it on the selected device."""
    try:
        return await project_service.create_git_workspace_project(
            db=db,
            project_data=project_create,
            user_id=current_user.id,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create Git workspace project: {str(e)}",
        )


@router.post(
    "/archive-chats",
    response_model=TaskArchiveBatchResponse,
)
def archive_all_project_chats_endpoint(
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Archive all active chats that belong to any project."""
    try:
        count = project_service.archive_all_project_chats(
            db=db, user_id=current_user.id, client_origin=client_origin
        )
        return {"message": "Project chats archived successfully", "count": count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to archive project chats: {str(e)}",
        )


@router.get("/worktrees", response_model=ProjectWorktreeListResponse)
async def list_project_worktrees_endpoint(
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List Wework worktree directories by scanning each relevant online device once."""
    try:
        return await project_service.list_project_worktrees(
            db=db,
            user_id=current_user.id,
            client_origin=client_origin,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list project worktrees: {str(e)}",
        )


@router.delete(
    "/worktrees/{device_id}/{worktree_id}",
    response_model=ProjectWorktreeDeleteResponse,
)
async def delete_project_worktree_endpoint(
    device_id: str = Path(..., description="Local execution device ID"),
    worktree_id: str = Path(..., description="Task ID worktree directory"),
    project_id: int = Query(..., description="Project ID matched to the worktree"),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a project worktree directory and its matching task."""
    try:
        return await project_service.delete_project_worktree(
            db=db,
            user_id=current_user.id,
            client_origin=client_origin,
            device_id=device_id,
            worktree_id=worktree_id,
            project_id=project_id,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete project worktree: {str(e)}",
        )


@router.get("/{project_id}", response_model=ProjectWithTasksResponse)
def get_project_endpoint(
    project_id: int = Path(..., description="Project ID"),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get project details by ID with its tasks.
    """
    project = project_service.get_project(
        db=db,
        project_id=project_id,
        user_id=current_user.id,
        client_origin=client_origin,
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
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
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
            client_origin=client_origin,
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
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete a project (soft delete).
    Tasks are not deleted, only their project_id is set to 0 (no project).
    """
    try:
        project_service.delete_project(
            db=db,
            project_id=project_id,
            user_id=current_user.id,
            client_origin=client_origin,
        )
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete project: {str(e)}",
        )


@router.post(
    "/{project_id}/conversations",
    response_model=ProjectConversationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_project_conversation_endpoint(
    project_id: int = Path(..., description="Project ID"),
    conversation_data: ProjectConversationCreate = Body(...),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new Task conversation under a workspace project.

    Project configuration supplies team, workspace, Git, and execution defaults.
    """
    try:
        return project_service.create_project_conversation(
            db=db,
            project_id=project_id,
            conversation_data=conversation_data,
            user=current_user,
            client_origin=client_origin,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create project conversation: {str(e)}",
        )


@router.post(
    "/{project_id}/archive-chats",
    response_model=TaskArchiveBatchResponse,
)
def archive_project_chats_endpoint(
    project_id: int = Path(..., description="Project ID"),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Archive all active chats in a project."""
    try:
        count = project_service.archive_project_chats(
            db=db,
            project_id=project_id,
            user_id=current_user.id,
            client_origin=client_origin,
        )
        return {"message": "Project chats archived successfully", "count": count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to archive project chats: {str(e)}",
        )


@router.post(
    "/{project_id}/terminal",
    response_model=ProjectDeviceSessionResponse,
)
async def start_project_terminal_session_endpoint(
    project_id: int = Path(..., description="Project ID"),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start a writable ttyd session for the project's bound local device."""
    return await project_device_session_service.start_project_device_session(
        db=db,
        user_id=current_user.id,
        project_id=project_id,
        session_type="terminal",
        client_origin=client_origin,
    )


@router.post(
    "/{project_id}/code-server",
    response_model=ProjectDeviceSessionResponse,
)
async def start_project_code_server_session_endpoint(
    project_id: int = Path(..., description="Project ID"),
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start a code-server session for the project's bound local device."""
    return await project_device_session_service.start_project_device_session(
        db=db,
        user_id=current_user.id,
        project_id=project_id,
        session_type="code_server",
        client_origin=client_origin,
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
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
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
            client_origin=client_origin,
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
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_FRONTEND,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove a task from a project.
    The task itself is not deleted, only the project_id is set to 0 (no project).
    """
    try:
        project_service.remove_task_from_project(
            db=db,
            project_id=project_id,
            task_id=task_id,
            user_id=current_user.id,
            client_origin=client_origin,
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
