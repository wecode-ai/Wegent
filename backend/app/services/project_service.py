# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project service for managing projects and project-task associations.

Projects are containers for organizing tasks. Each task can belong to one project.
"""

import posixpath
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.project import Project
from app.models.task import TaskResource
from app.schemas.project import (
    GitWorkspaceProjectCreate,
    GitWorkspaceProjectResponse,
    ProjectConfig,
    ProjectConversationCreate,
    ProjectConversationResponse,
    ProjectCreate,
    ProjectListResponse,
    ProjectResponse,
    ProjectTaskResponse,
    ProjectUpdate,
    ProjectWithTasksResponse,
)
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.device.command_service import (
    execute_configured_device_command,
)

GIT_CLONE_TIMEOUT_SECONDS = 600


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
        .filter(
            Project.user_id == user_id,
            Project.client_origin == project_data.client_origin,
            Project.is_active == True,
        )
        .scalar()
    )
    next_sort_order = (max_sort_order or 0) + 1

    config = _dump_config(project_data.config)

    new_project = Project(
        user_id=user_id,
        name=project_data.name,
        description=project_data.description,
        color=project_data.color or "",
        client_origin=project_data.client_origin,
        config=config,
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


async def create_git_workspace_project(
    db: Session,
    project_data: GitWorkspaceProjectCreate,
    user_id: int,
) -> GitWorkspaceProjectResponse:
    """Create a Git-backed workspace project and clone its checkout."""

    repo_name = _default_git_project_name(project_data.git.repo, project_data.git.url)
    config = ProjectConfig.model_validate(
        {
            "mode": "workspace",
            "execution": {
                "targetType": "local",
                "deviceId": project_data.device_id,
            },
            "workspace": {"source": "git"},
            "git": project_data.git.model_dump(),
        }
    )
    if not config.workspace or not config.workspace.checkoutPath:
        raise HTTPException(
            status_code=400,
            detail="Git workspace checkout path could not be resolved",
        )

    project = create_project(
        db=db,
        project_data=ProjectCreate(
            name=project_data.name or repo_name,
            description=project_data.description,
            color=project_data.color,
            client_origin=project_data.client_origin,
            config=config,
        ),
        user_id=user_id,
    )

    try:
        reused_checkout = await _prepare_git_checkout(
            db=db,
            user_id=user_id,
            device_id=project_data.device_id,
            git_url=project_data.git.url,
            branch=project_data.git.branch,
            checkout_path=config.workspace.checkoutPath,
        )
    except Exception:
        _deactivate_project(db, project.id, user_id, project_data.client_origin)
        raise

    return GitWorkspaceProjectResponse(
        project=project,
        checkout_path=config.workspace.checkoutPath,
        reused_existing_checkout=reused_checkout,
    )


def _default_git_project_name(repo: Optional[str], git_url: str) -> str:
    """Return a display name for a Git workspace project."""

    source = repo or git_url.rstrip("/").split("/")[-1]
    return source.rstrip("/").removesuffix(".git").split("/")[-1] or "repository"


async def _prepare_git_checkout(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    git_url: str,
    branch: Optional[str],
    checkout_path: str,
) -> bool:
    """Clone the Git checkout on the selected local device."""

    root_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="project_workspace_root",
    )
    workspace_root = str(root_result.get("stdout", "")).strip()
    if not workspace_root:
        raise HTTPException(status_code=400, detail="Project workspace root is empty")

    root_mkdir_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="mkdir_p",
        args=[workspace_root],
    )
    _raise_for_failed_command(
        root_mkdir_result,
        "Failed to create project workspace root",
    )

    target_path = _join_device_path(workspace_root, checkout_path)
    exists_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="path_exists",
        path=workspace_root,
        args=[checkout_path],
        timeout_seconds=30,
    )
    if _command_succeeded(exists_result):
        raise _target_path_exists_error(target_path)

    parent_path = posixpath.dirname(checkout_path)
    if parent_path and parent_path != ".":
        mkdir_result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="mkdir_p",
            path=workspace_root,
            args=[parent_path],
        )
        _raise_for_failed_command(mkdir_result, "Failed to create project directory")

    clone_args = _build_git_clone_args(git_url, branch, checkout_path)
    clone_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="git_clone",
        path=workspace_root,
        args=clone_args,
        timeout_seconds=GIT_CLONE_TIMEOUT_SECONDS,
        max_output_bytes=5 * 1024 * 1024,
    )
    _raise_for_failed_command(clone_result, "Failed to clone Git repository")
    return False


def _build_git_clone_args(
    git_url: str,
    branch: Optional[str],
    checkout_path: str,
) -> list[str]:
    args: list[str] = []
    if branch and branch.strip():
        args.extend(["--branch", branch.strip(), "--single-branch"])
    args.extend([git_url, checkout_path])
    return args


def _join_device_path(root: str, relative_path: str) -> str:
    return f"{root.rstrip('/')}/{relative_path.strip('/')}"


def _command_succeeded(result: dict[str, Any]) -> bool:
    return bool(result.get("success")) and result.get("exit_code") == 0


def _raise_for_failed_command(result: dict[str, Any], message: str) -> None:
    if _command_succeeded(result):
        return
    detail = str(result.get("stderr") or result.get("error") or message)
    raise HTTPException(status_code=400, detail=detail)


def _target_path_exists_error(target_path: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=f"Target project directory already exists: {target_path}",
    )


def _deactivate_project(
    db: Session,
    project_id: int,
    user_id: int,
    client_origin: Optional[str],
) -> None:
    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()
    if project:
        project.is_active = False
        db.commit()


def get_project(
    db: Session, project_id: int, user_id: int, client_origin: Optional[str] = None
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
    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()

    if not project:
        return None

    # Get tasks in this project
    tasks = _get_project_tasks(db, project_id, client_origin=client_origin)

    # Build response manually to avoid auto-validation of tasks relationship
    return ProjectWithTasksResponse(
        id=project.id,
        user_id=project.user_id,
        name=project.name,
        description=project.description or "",
        color=project.color,
        client_origin=project.client_origin,
        config=project.config,
        sort_order=project.sort_order,
        is_expanded=project.is_expanded,
        task_count=len(tasks),
        created_at=project.created_at,
        updated_at=project.updated_at,
        tasks=tasks,
    )


def list_projects(
    db: Session,
    user_id: int,
    include_tasks: bool = True,
    client_origin: Optional[str] = None,
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
    query = db.query(Project).filter(
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    projects = query.order_by(Project.sort_order.asc()).all()

    items = []
    for project in projects:
        if include_tasks:
            tasks = _get_project_tasks(db, project.id, client_origin=client_origin)
        else:
            tasks = []

        task_count = (
            len(tasks)
            if include_tasks
            else (
                db.query(TaskResource)
                .filter(
                    TaskResource.project_id == project.id,
                    TaskResource.is_active == TaskResource.STATE_ACTIVE,
                    *(
                        [TaskResource.client_origin == client_origin]
                        if client_origin
                        else []
                    ),
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
            client_origin=project.client_origin,
            config=project.config,
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
    db: Session,
    project_id: int,
    update_data: ProjectUpdate,
    user_id: int,
    client_origin: Optional[str] = None,
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
    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Update fields
    update_dict = update_data.model_dump(exclude_unset=True)
    for field, value in update_dict.items():
        if hasattr(project, field):
            if field == "config":
                value = _dump_config(update_data.config)
            setattr(project, field, value)
            if field == "config":
                flag_modified(project, "config")

    db.commit()
    db.refresh(project)

    response = ProjectResponse.model_validate(project)
    response.task_count = (
        db.query(TaskResource)
        .filter(
            TaskResource.project_id == project_id,
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
            *([TaskResource.client_origin == client_origin] if client_origin else []),
        )
        .count()
    )
    return response


def create_project_conversation(
    db: Session,
    project_id: int,
    conversation_data: ProjectConversationCreate,
    user,
    client_origin: Optional[str] = None,
) -> ProjectConversationResponse:
    """Create a new Task conversation under a workspace project."""

    project = _get_active_project(db, project_id, user.id, client_origin=client_origin)
    config = ProjectConfig.model_validate(project.config or {})
    if not config.is_workspace:
        raise HTTPException(
            status_code=400,
            detail="Project conversations are only supported for workspace projects",
        )

    task_create = _build_project_task_create(
        project=project,
        config=config,
        conversation_data=conversation_data,
    )
    task_result = task_kinds_service.create_task_or_append(
        db=db,
        obj_in=task_create,
        user=user,
        task_id=None,
    )

    task_id = int(task_result["id"])
    return ProjectConversationResponse(
        task_id=task_id,
        project_id=project_id,
        task=task_result,
    )


def delete_project(
    db: Session, project_id: int, user_id: int, client_origin: Optional[str] = None
) -> None:
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
    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Clear project_id for all tasks in this project (set to 0, not NULL)
    db.query(TaskResource).filter(
        TaskResource.project_id == project_id,
        TaskResource.user_id == user_id,
        *([TaskResource.client_origin == client_origin] if client_origin else []),
    ).update({TaskResource.project_id: 0})

    # Soft delete the project
    project.is_active = False
    db.commit()


def archive_project_chats(
    db: Session, project_id: int, user_id: int, client_origin: Optional[str] = None
) -> int:
    """Archive all active chats belonging to a project."""

    _get_active_project(db, project_id, user_id, client_origin=client_origin)
    return task_kinds_service.archive_project_chats(
        db=db, project_id=project_id, user_id=user_id, client_origin=client_origin
    )


def archive_all_project_chats(
    db: Session, user_id: int, client_origin: Optional[str] = None
) -> int:
    """Archive all active chats belonging to any project owned by the user."""

    return task_kinds_service.archive_all_project_chats(
        db=db, user_id=user_id, client_origin=client_origin
    )


def add_task_to_project(
    db: Session,
    project_id: int,
    task_id: int,
    user_id: int,
    client_origin: Optional[str] = None,
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
    project = _get_active_project(db, project_id, user_id, client_origin=client_origin)

    # Verify task exists and belongs to user
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
            *([TaskResource.client_origin == client_origin] if client_origin else []),
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Update task's project_id
    task.project_id = project_id
    task.client_origin = project.client_origin
    _set_task_project_label(task, project_id)
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
        updated_at=task.updated_at,
    )


def remove_task_from_project(
    db: Session,
    project_id: int,
    task_id: int,
    user_id: int,
    client_origin: Optional[str] = None,
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
    _get_active_project(db, project_id, user_id, client_origin=client_origin)

    # Find task and verify it belongs to this project
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.project_id == project_id,
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
            *([TaskResource.client_origin == client_origin] if client_origin else []),
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found in project")

    # Remove task from project by setting project_id to 0 (default value for no project)
    task.project_id = 0
    _set_task_project_label(task, None)
    db.commit()


def _get_project_tasks(
    db: Session, project_id: int, client_origin: Optional[str] = None
) -> list[ProjectTaskResponse]:
    """
    Get all tasks in a project with their details.

    Args:
        db: Database session
        project_id: Project ID

    Returns:
        List of project tasks with details
    """
    query = db.query(TaskResource).filter(
        TaskResource.project_id == project_id,
        TaskResource.kind == "Task",
        TaskResource.is_active == TaskResource.STATE_ACTIVE,
    )
    if client_origin:
        query = query.filter(TaskResource.client_origin == client_origin)
    tasks = query.order_by(TaskResource.updated_at.desc()).all()

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
                updated_at=task.updated_at,
            )
        )

    return result


def _get_active_project(
    db: Session, project_id: int, user_id: int, client_origin: Optional[str] = None
) -> Project:
    """Return an active project owned by a user."""

    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _dump_config(config: Optional[ProjectConfig]) -> Optional[dict]:
    """Convert project config to JSON-ready dict."""

    if config is None:
        return None
    return config.model_dump(mode="json", exclude_none=True)


def _set_task_project_label(task: TaskResource, project_id: Optional[int]) -> None:
    """Set or clear the projectId task metadata label."""

    task_json = dict(task.json or {})
    metadata = dict(task_json.get("metadata") or {})
    labels = dict(metadata.get("labels") or {})
    if project_id:
        labels["projectId"] = str(project_id)
    else:
        labels.pop("projectId", None)
    metadata["labels"] = labels
    task_json["metadata"] = metadata
    task.json = task_json
    flag_modified(task, "json")


def _build_project_task_create(
    project: Project,
    config: ProjectConfig,
    conversation_data: ProjectConversationCreate,
) -> TaskCreate:
    """Build TaskCreate from a workspace project config."""

    team = config.team
    workspace = config.workspace
    git = config.git
    assert workspace is not None

    title = conversation_data.title or conversation_data.prompt[:50]
    if not conversation_data.title and len(conversation_data.prompt) > 50:
        title += "..."

    return TaskCreate(
        title=title,
        team_id=team.id if team else None,
        team_name=team.name if team else None,
        team_namespace=team.namespace if team else "default",
        git_url=git.url if git else "",
        git_repo=git.repo if git and git.repo else "",
        git_repo_id=git.repoId if git and git.repoId else 0,
        git_domain=git.domain if git and git.domain else "",
        branch_name=git.branch if git and git.branch else "",
        prompt=conversation_data.prompt,
        type="offline",
        task_type="code",
        auto_delete_executor="false",
        source="project",
        client_origin=project.client_origin,
        project_id=project.id,
    )
