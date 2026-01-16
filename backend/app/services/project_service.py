# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project service for managing projects and project-task associations.

Projects are containers for organizing tasks. Each task can belong to one project.
"""
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.task import TaskResource
from app.schemas.project import (
    ProjectCreate,
    ProjectListResponse,
    ProjectResponse,
    ProjectTaskResponse,
    ProjectUpdate,
    ProjectWithTasksResponse,
)


def create_project(
    db: Session, project_data: ProjectCreate, user_id: int
) -> ProjectResponse:
    """
    Create a new project.

    Args:
        db: Database session
        project_data: Project creation data
        user_id: User ID of the project owner

    Returns:
        Created project response
    """
    # Get the max sort_order for this user's projects
    max_sort_order = (
        db.query(func.max(Project.sort_order))
        .filter(Project.user_id == user_id, Project.is_active == True)
        .scalar()
    )
    next_sort_order = (max_sort_order or 0) + 1

    # Create project
    # Use empty string for color if not provided, since DB column is NOT NULL DEFAULT ''
    new_project = Project(
        user_id=user_id,
        name=project_data.name,
        description=project_data.description,
        color=project_data.color or "",
        sort_order=next_sort_order,
        is_expanded=True,
        is_active=True,
    )

    db.add(new_project)
    db.commit()
    db.refresh(new_project)

    response = ProjectResponse.model_validate(new_project)
    response.task_count = 0
    return response


def get_project(
    db: Session, project_id: int, user_id: int
) -> Optional[ProjectWithTasksResponse]:
    """
    Get a project by ID with its tasks.

    Args:
        db: Database session
        project_id: Project ID
        user_id: User ID (for ownership verification)

    Returns:
        Project with tasks or None if not found
    """
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.is_active == True,
        )
        .first()
    )

    if not project:
        return None

    # Get tasks in this project
    tasks = _get_project_tasks(db, project_id)

    # Build response manually to avoid auto-validation of tasks relationship
    return ProjectWithTasksResponse(
        id=project.id,
        user_id=project.user_id,
        name=project.name,
        description=project.description or "",
        color=project.color,
        sort_order=project.sort_order,
        is_expanded=project.is_expanded,
        task_count=len(tasks),
        created_at=project.created_at,
        updated_at=project.updated_at,
        tasks=tasks,
    )


def list_projects(
    db: Session, user_id: int, include_tasks: bool = True
) -> ProjectListResponse:
    """
    List all projects for a user.

    Args:
        db: Database session
        user_id: User ID
        include_tasks: Whether to include tasks in the response

    Returns:
        List of projects with optional tasks
    """
    projects = (
        db.query(Project)
        .filter(
            Project.user_id == user_id,
            Project.is_active == True,
        )
        .order_by(Project.sort_order.asc())
        .all()
    )

    items = []
    for project in projects:
        if include_tasks:
            tasks = _get_project_tasks(db, project.id)
        else:
            tasks = []

        task_count = (
            len(tasks)
            if include_tasks
            else (
                db.query(TaskResource)
                .filter(
                    TaskResource.project_id == project.id,
                    TaskResource.is_active == True,
                )
                .count()
            )
        )

        # Build response manually to avoid auto-validation of tasks relationship
        response = ProjectWithTasksResponse(
            id=project.id,
            user_id=project.user_id,
            name=project.name,
            description=project.description or "",
            color=project.color,
            sort_order=project.sort_order,
            is_expanded=project.is_expanded,
            task_count=task_count,
            created_at=project.created_at,
            updated_at=project.updated_at,
            tasks=tasks,
        )
        items.append(response)

    return ProjectListResponse(total=len(items), items=items)


def update_project(
    db: Session, project_id: int, update_data: ProjectUpdate, user_id: int
) -> ProjectResponse:
    """
    Update a project.

    Args:
        db: Database session
        project_id: Project ID
        update_data: Update data
        user_id: User ID (for ownership verification)

    Returns:
        Updated project response

    Raises:
        HTTPException: If project not found
    """
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.is_active == True,
        )
        .first()
    )

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Update fields
    update_dict = update_data.model_dump(exclude_unset=True)
    for field, value in update_dict.items():
        if hasattr(project, field):
            setattr(project, field, value)

    db.commit()
    db.refresh(project)

    response = ProjectResponse.model_validate(project)
    response.task_count = (
        db.query(TaskResource)
        .filter(
            TaskResource.project_id == project_id,
            TaskResource.is_active == True,
        )
        .count()
    )
    return response


def delete_project(db: Session, project_id: int, user_id: int) -> None:
    """
    Delete a project (soft delete).

    Tasks are not deleted, only their project_id is set to NULL.

    Args:
        db: Database session
        project_id: Project ID
        user_id: User ID (for ownership verification)

    Raises:
        HTTPException: If project not found
    """
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.is_active == True,
        )
        .first()
    )

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Clear project_id for all tasks in this project
    db.query(TaskResource).filter(TaskResource.project_id == project_id).update(
        {TaskResource.project_id: None}
    )

    # Soft delete the project
    project.is_active = False
    db.commit()


def add_task_to_project(
    db: Session, project_id: int, task_id: int, user_id: int
) -> ProjectTaskResponse:
    """
    Add a task to a project.

    Args:
        db: Database session
        project_id: Project ID
        task_id: Task ID
        user_id: User ID (for ownership verification)

    Returns:
        Updated task response

    Raises:
        HTTPException: If project or task not found, or task already in a project
    """
    # Verify project ownership
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.is_active == True,
        )
        .first()
    )

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Verify task exists and belongs to user
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Update task's project_id
    task.project_id = project_id
    db.commit()
    db.refresh(task)

    # Get task details for response
    task_json = task.json or {}
    spec = task_json.get("spec", {})
    is_group_chat = spec.get("is_group_chat", False)
    task_status = task_json.get("status", {}).get("phase", "PENDING")
    # Task title is stored in spec.title, fallback to task.name
    task_title = spec.get("title") or task.name or f"Task #{task_id}"

    return ProjectTaskResponse(
        task_id=task_id,
        task_title=task_title,
        task_status=task_status,
        is_group_chat=is_group_chat,
        project_id=project_id,
    )


def remove_task_from_project(
    db: Session, project_id: int, task_id: int, user_id: int
) -> None:
    """
    Remove a task from a project.

    Args:
        db: Database session
        project_id: Project ID
        task_id: Task ID
        user_id: User ID (for ownership verification)

    Raises:
        HTTPException: If project or task not found
    """
    # Verify project ownership
    project = (
        db.query(Project)
        .filter(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.is_active == True,
        )
        .first()
    )

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Find task and verify it belongs to this project
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.project_id == project_id,
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found in project")

    # Remove task from project by setting project_id to NULL
    task.project_id = None
    db.commit()


def _get_project_tasks(db: Session, project_id: int) -> list[ProjectTaskResponse]:
    """
    Get all tasks in a project with their details.

    Args:
        db: Database session
        project_id: Project ID

    Returns:
        List of project tasks with details
    """
    tasks = (
        db.query(TaskResource)
        .filter(
            TaskResource.project_id == project_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .order_by(TaskResource.created_at.desc())
        .all()
    )

    result = []
    for task in tasks:
        task_json = task.json or {}
        spec = task_json.get("spec", {})
        is_group_chat = spec.get("is_group_chat", False)
        task_status = task_json.get("status", {}).get("phase", "PENDING")
        # Task title is stored in spec.title, fallback to task.name
        task_title = spec.get("title") or task.name or f"Task #{task.id}"

        result.append(
            ProjectTaskResponse(
                task_id=task.id,
                task_title=task_title,
                task_status=task_status,
                is_group_chat=is_group_chat,
                project_id=project_id,
            )
        )

    return result
