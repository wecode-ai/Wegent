# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project service for managing projects and project-task associations.

Projects are containers for organizing tasks. A task can belong to multiple projects.
"""
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.project import Project, ProjectTask
from app.models.task import TaskResource
from app.schemas.project import (
    ProjectCreate,
    ProjectListResponse,
    ProjectResponse,
    ProjectTaskReorderRequest,
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
    new_project = Project(
        user_id=user_id,
        name=project_data.name,
        description=project_data.description,
        color=project_data.color,
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

    response = ProjectWithTasksResponse.model_validate(project)
    response.task_count = len(tasks)
    response.tasks = tasks
    return response


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
            response = ProjectWithTasksResponse.model_validate(project)
            response.task_count = len(tasks)
            response.tasks = tasks
        else:
            response = ProjectWithTasksResponse.model_validate(project)
            response.task_count = (
                db.query(ProjectTask)
                .filter(ProjectTask.project_id == project.id)
                .count()
            )
            response.tasks = []
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
        db.query(ProjectTask).filter(ProjectTask.project_id == project_id).count()
    )
    return response


def delete_project(db: Session, project_id: int, user_id: int) -> None:
    """
    Delete a project (soft delete).

    Tasks are not deleted, only the project-task associations are removed.

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

    # Soft delete the project (cascade will handle project_tasks)
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
        Created project-task association

    Raises:
        HTTPException: If project or task not found, or task already in project
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

    # Check if task is already in project
    existing = (
        db.query(ProjectTask)
        .filter(
            ProjectTask.project_id == project_id,
            ProjectTask.task_id == task_id,
        )
        .first()
    )

    if existing:
        raise HTTPException(status_code=400, detail="Task is already in this project")

    # Get max sort_order for tasks in this project
    max_sort_order = (
        db.query(func.max(ProjectTask.sort_order))
        .filter(ProjectTask.project_id == project_id)
        .scalar()
    )
    next_sort_order = (max_sort_order or 0) + 1

    # Create association
    project_task = ProjectTask(
        project_id=project_id,
        task_id=task_id,
        sort_order=next_sort_order,
    )

    db.add(project_task)
    db.commit()
    db.refresh(project_task)

    # Get task details for response
    task_json = task.json or {}
    spec = task_json.get("spec", {})
    is_group_chat = spec.get("is_group_chat", False)
    task_status = task_json.get("status", {}).get("phase", "PENDING")
    # Task title is stored in spec.title, fallback to task.name
    task_title = spec.get("title") or task.name or f"Task #{task_id}"

    return ProjectTaskResponse(
        id=project_task.id,
        task_id=task_id,
        task_title=task_title,
        task_status=task_status,
        is_group_chat=is_group_chat,
        sort_order=project_task.sort_order,
        added_at=project_task.added_at,
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
        HTTPException: If project or association not found
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

    # Find and delete association
    project_task = (
        db.query(ProjectTask)
        .filter(
            ProjectTask.project_id == project_id,
            ProjectTask.task_id == task_id,
        )
        .first()
    )

    if not project_task:
        raise HTTPException(status_code=404, detail="Task not found in project")

    db.delete(project_task)
    db.commit()


def reorder_project_tasks(
    db: Session, project_id: int, reorder_data: ProjectTaskReorderRequest, user_id: int
) -> list[ProjectTaskResponse]:
    """
    Reorder tasks within a project.

    Args:
        db: Database session
        project_id: Project ID
        reorder_data: New task order
        user_id: User ID (for ownership verification)

    Returns:
        Updated list of project tasks

    Raises:
        HTTPException: If project not found
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

    # Update sort_order for each task
    for index, task_id in enumerate(reorder_data.task_ids):
        project_task = (
            db.query(ProjectTask)
            .filter(
                ProjectTask.project_id == project_id,
                ProjectTask.task_id == task_id,
            )
            .first()
        )

        if project_task:
            project_task.sort_order = index

    db.commit()

    return _get_project_tasks(db, project_id)


def _get_project_tasks(db: Session, project_id: int) -> list[ProjectTaskResponse]:
    """
    Get all tasks in a project with their details.

    Args:
        db: Database session
        project_id: Project ID

    Returns:
        List of project tasks with details
    """
    project_tasks = (
        db.query(ProjectTask)
        .filter(ProjectTask.project_id == project_id)
        .order_by(ProjectTask.sort_order.asc())
        .all()
    )

    result = []
    for pt in project_tasks:
        # Get task details
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == pt.task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if task:
            task_json = task.json or {}
            spec = task_json.get("spec", {})
            is_group_chat = spec.get("is_group_chat", False)
            task_status = task_json.get("status", {}).get("phase", "PENDING")
            # Task title is stored in spec.title, fallback to task.name
            task_title = spec.get("title") or task.name or f"Task #{pt.task_id}"

            result.append(
                ProjectTaskResponse(
                    id=pt.id,
                    task_id=pt.task_id,
                    task_title=task_title,
                    task_status=task_status,
                    is_group_chat=is_group_chat,
                    sort_order=pt.sort_order,
                    added_at=pt.added_at,
                )
            )

    return result
