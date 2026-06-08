# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project service for managing projects and project-task associations.

Projects are containers for organizing tasks. Each task can belong to one project.
"""

import posixpath
import re
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
    ProjectWorkspaceConfig,
    ProjectWorktreeDeleteResponse,
    ProjectWorktreeDeviceGroup,
    ProjectWorktreeItem,
    ProjectWorktreeListResponse,
    ProjectWorktreeProjectRef,
    ProjectWorktreeTaskRef,
)
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.device.command_service import (
    execute_configured_device_command,
)
from app.services.device_service import device_service

GIT_CLONE_TIMEOUT_SECONDS = 600
GIT_WORKTREE_TIMEOUT_SECONDS = 120
GIT_REPOSITORY_CHECK_TIMEOUT_SECONDS = 30
FIND_WORKTREES_TIMEOUT_SECONDS = 30
WORKTREE_ROOT_DIR = "worktrees"
WORKTREE_ID_PATTERN = re.compile(r"^[1-9][0-9]*$")


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


async def prepare_git_worktree_for_task(
    *,
    db: Session,
    user_id: int,
    project_id: int,
    client_origin: Optional[str],
    task_id: int,
) -> dict[str, str]:
    """Create a Git worktree for a project task and return task execution metadata."""

    project = _get_active_project(
        db=db,
        project_id=project_id,
        user_id=user_id,
        client_origin=client_origin,
    )
    config = ProjectConfig.model_validate(project.config or {})
    if not config.is_workspace or not config.execution or not config.workspace:
        raise HTTPException(
            status_code=400,
            detail="Git worktree requires a local workspace project",
        )
    if config.execution.targetType != "local" or not config.execution.deviceId:
        raise HTTPException(
            status_code=400,
            detail="Git worktree requires a bound local device",
        )

    source_workspace_path = _source_workspace_path(config.workspace)
    if not source_workspace_path:
        raise HTTPException(
            status_code=400,
            detail="Git worktree requires a project workspace path",
        )

    workspace_root = await _resolve_project_workspace_root(
        db=db,
        user_id=user_id,
        device_id=config.execution.deviceId,
    )
    executor_workspace_root = _resolve_executor_workspace_root(workspace_root)
    source_checkout_path = _resolve_source_workspace_abs_path(
        workspace_root,
        source_workspace_path,
    )
    await _ensure_git_worktree_source(
        db=db,
        user_id=user_id,
        device_id=config.execution.deviceId,
        source_checkout_path=source_checkout_path,
    )
    worktree_path = await _create_task_worktree(
        db=db,
        user_id=user_id,
        device_id=config.execution.deviceId,
        executor_workspace_root=executor_workspace_root,
        source_checkout_path=source_checkout_path,
        source_workspace_path=source_workspace_path,
        worktree_id=str(task_id),
    )

    return {"source": "git_worktree", "path": worktree_path}


async def list_project_worktrees(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
) -> ProjectWorktreeListResponse:
    """List Wegent worktree directories by scanning each relevant online device once."""

    project_refs = _collect_worktree_project_refs(
        db=db,
        user_id=user_id,
        client_origin=client_origin,
    )
    device_ids = sorted({ref["device_id"] for ref in project_refs})
    devices = await device_service.get_all_devices(db, user_id)
    devices_by_id = {str(device.get("device_id")): device for device in devices}
    project_index = _build_worktree_project_index(project_refs)

    groups = [
        await _build_worktree_device_group(
            db=db,
            user_id=user_id,
            client_origin=client_origin,
            device_id=device_id,
            device=devices_by_id.get(device_id, {}),
            project_index=project_index.get(device_id, {}),
        )
        for device_id in device_ids
    ]
    return ProjectWorktreeListResponse(
        devices=groups,
        total=sum(len(group.items) for group in groups),
    )


async def delete_project_worktree(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
    device_id: str,
    worktree_id: str,
    project_id: int,
) -> ProjectWorktreeDeleteResponse:
    """Delete a managed project worktree directory and its matching task."""

    normalized_worktree_id = _normalize_worktree_id(worktree_id)
    project = _get_active_project(
        db=db,
        project_id=project_id,
        user_id=user_id,
        client_origin=client_origin,
    )
    project_ref = _worktree_project_ref_from_project(project)
    if not project_ref:
        raise HTTPException(
            status_code=400,
            detail="Project is not a local workspace project",
        )
    if project_ref["device_id"] != device_id:
        raise HTTPException(
            status_code=400,
            detail="Worktree project is not bound to this device",
        )

    workspace_root = await _resolve_project_workspace_root(
        db=db,
        user_id=user_id,
        device_id=device_id,
    )
    worktree_root = _join_device_path(
        _resolve_executor_workspace_root(workspace_root),
        WORKTREE_ROOT_DIR,
    )
    target_path = _join_device_path(
        worktree_root,
        f"{normalized_worktree_id}/{project_ref['project_dir_name']}",
    )

    exists_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="path_exists",
        args=[target_path],
        timeout_seconds=30,
    )
    if not _command_succeeded(exists_result):
        raise HTTPException(status_code=404, detail="Worktree not found")

    matching_tasks = _find_worktree_tasks(
        db=db,
        user_id=user_id,
        project_id=project_id,
        client_origin=client_origin,
        worktree_id=normalized_worktree_id,
        worktree_path=target_path,
    )
    source_checkout_path = _resolve_source_workspace_abs_path(
        workspace_root,
        project_ref["source_path"],
    )

    await _remove_worktree_directory(
        db=db,
        user_id=user_id,
        device_id=device_id,
        source_checkout_path=source_checkout_path,
        target_path=target_path,
    )

    deleted_task_ids: list[int] = []
    for task in matching_tasks:
        task_kinds_service.delete_task(
            db=db,
            task_id=task.id,
            user_id=user_id,
            client_origin=client_origin,
        )
        deleted_task_ids.append(task.id)

    return ProjectWorktreeDeleteResponse(
        worktree_id=normalized_worktree_id,
        path=target_path,
        deleted_task_ids=deleted_task_ids,
    )


async def _build_worktree_device_group(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
    device_id: str,
    device: dict[str, Any],
    project_index: dict[str, list[dict[str, Any]]],
) -> ProjectWorktreeDeviceGroup:
    device_name = str(device.get("name") or device_id)
    device_status = str(device.get("status") or "offline")
    if device_status not in {"online", "busy"}:
        return ProjectWorktreeDeviceGroup(
            device_id=device_id,
            device_name=device_name,
            device_status=device_status,
            available=False,
            error="Device is offline",
            items=[],
        )

    try:
        scanned_items = await _scan_device_worktree_items(
            db=db,
            user_id=user_id,
            client_origin=client_origin,
            device_id=device_id,
            project_index=project_index,
        )
        return ProjectWorktreeDeviceGroup(
            device_id=device_id,
            device_name=device_name,
            device_status=device_status,
            available=True,
            items=scanned_items,
        )
    except Exception as exc:
        return ProjectWorktreeDeviceGroup(
            device_id=device_id,
            device_name=device_name,
            device_status=device_status,
            available=False,
            error=str(exc),
            items=[],
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

    workspace_root = await _resolve_project_workspace_root(
        db=db,
        user_id=user_id,
        device_id=device_id,
    )

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


async def _resolve_project_workspace_root(
    *,
    db: Session,
    user_id: int,
    device_id: str,
) -> str:
    root_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="project_workspace_root",
    )
    workspace_root = str(root_result.get("stdout", "")).strip()
    if not workspace_root:
        raise HTTPException(status_code=400, detail="Project workspace root is empty")
    return workspace_root


def _source_workspace_path(workspace: ProjectWorkspaceConfig) -> Optional[str]:
    if workspace.source == "git":
        return workspace.checkoutPath
    return workspace.localPath or workspace.checkoutPath


def _resolve_source_workspace_abs_path(
    workspace_root: str, source_workspace_path: str
) -> str:
    if posixpath.isabs(source_workspace_path):
        return source_workspace_path
    if source_workspace_path.startswith("projects/"):
        return _join_device_path(
            _resolve_executor_workspace_root(workspace_root),
            source_workspace_path,
        )
    return _join_device_path(workspace_root, source_workspace_path)


def _resolve_executor_workspace_root(project_workspace_root: str) -> str:
    normalized_root = project_workspace_root.rstrip("/") or "/"
    if posixpath.basename(normalized_root) == "projects":
        return posixpath.dirname(normalized_root) or "/"
    return normalized_root


async def _ensure_git_worktree_source(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    source_checkout_path: str,
) -> None:
    result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="git_is_worktree",
        args=[source_checkout_path],
        timeout_seconds=GIT_REPOSITORY_CHECK_TIMEOUT_SECONDS,
    )
    if _command_succeeded(result) and str(result.get("stdout", "")).strip() == "true":
        return

    raise HTTPException(
        status_code=400,
        detail="Project directory is not a Git repository",
    )


async def _create_task_worktree(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    executor_workspace_root: str,
    source_checkout_path: str,
    source_workspace_path: str,
    worktree_id: str,
) -> str:
    relative_path = _build_git_worktree_path(source_workspace_path, worktree_id)
    target_path = _join_device_path(executor_workspace_root, relative_path)
    worktree_id_path = posixpath.dirname(target_path)
    exists_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="path_exists",
        args=[worktree_id_path],
        timeout_seconds=30,
    )
    if _command_succeeded(exists_result):
        raise HTTPException(status_code=409, detail="Git worktree path already exists")

    mkdir_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="mkdir_p",
        args=[worktree_id_path],
    )
    _raise_for_failed_command(mkdir_result, "Failed to create worktree directory")

    worktree_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="git_worktree_add",
        args=[source_checkout_path, target_path],
        timeout_seconds=GIT_WORKTREE_TIMEOUT_SECONDS,
        max_output_bytes=1024 * 1024,
    )
    _raise_for_failed_command(worktree_result, "Failed to create Git worktree")
    return target_path


def _build_git_worktree_path(checkout_path: str, worktree_id: str) -> str:
    project_dir_name = _project_dir_name_from_path(checkout_path)
    worktree_id = _normalize_worktree_id(worktree_id)
    return f"{WORKTREE_ROOT_DIR}/{worktree_id}/{project_dir_name}"


def _normalize_worktree_id(worktree_id: str) -> str:
    normalized = worktree_id.strip()
    if not WORKTREE_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=404, detail="Worktree not found")
    return normalized


def _project_dir_name_from_path(path: str) -> str:
    parts = [part for part in path.rstrip("/").split("/") if part and part != "."]
    return _sanitize_path_segment(parts[-1] if parts else "", fallback="project")


def _sanitize_path_segment(value: str, *, fallback: str) -> str:
    segment = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    return segment.strip(".-_") or fallback


def _worktree_project_ref_from_project(project: Project) -> Optional[dict[str, Any]]:
    try:
        config = ProjectConfig.model_validate(project.config or {})
    except Exception:
        return None
    if (
        not config.is_workspace
        or not config.execution
        or not config.workspace
        or config.execution.targetType != "local"
        or not config.execution.deviceId
    ):
        return None
    source_path = _source_workspace_path(config.workspace)
    if not source_path:
        return None
    return {
        "project_id": project.id,
        "project_name": project.name,
        "device_id": config.execution.deviceId,
        "source_path": source_path,
        "project_dir_name": _project_dir_name_from_path(source_path),
    }


def _collect_worktree_project_refs(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
) -> list[dict[str, Any]]:
    query = db.query(Project).filter(
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)

    refs: list[dict[str, Any]] = []
    for project in query.order_by(Project.sort_order.asc(), Project.id.asc()).all():
        ref = _worktree_project_ref_from_project(project)
        if ref:
            refs.append(ref)
    return refs


def _build_worktree_project_index(
    project_refs: list[dict[str, Any]],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    index: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for ref in project_refs:
        by_name = index.setdefault(ref["device_id"], {})
        by_name.setdefault(ref["project_dir_name"], []).append(ref)
        lower_name = str(ref["project_dir_name"]).lower()
        if lower_name != ref["project_dir_name"]:
            by_name.setdefault(lower_name, []).append(ref)
    return index


async def _scan_device_worktree_items(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
    device_id: str,
    project_index: dict[str, list[dict[str, Any]]],
) -> list[ProjectWorktreeItem]:
    workspace_root = await _resolve_project_workspace_root(
        db=db,
        user_id=user_id,
        device_id=device_id,
    )
    worktree_root = _join_device_path(
        _resolve_executor_workspace_root(workspace_root),
        WORKTREE_ROOT_DIR,
    )
    result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="find_worktree_dirs",
        args=[worktree_root],
        timeout_seconds=FIND_WORKTREES_TIMEOUT_SECONDS,
        max_output_bytes=1024 * 1024,
    )
    _raise_for_failed_command(result, "Failed to list worktree directories")

    raw_paths = result.get("stdout")
    paths = (
        raw_paths
        if isinstance(raw_paths, list)
        else [line.strip() for line in str(raw_paths or "").splitlines()]
    )
    items = [
        item
        for path in paths
        if isinstance(path, str)
        for item in [_build_worktree_item(worktree_root, path, project_index)]
        if item is not None
    ]
    items = _attach_worktree_task_refs(
        db=db,
        user_id=user_id,
        client_origin=client_origin,
        items=items,
    )
    return sorted(items, key=lambda item: (item.project_name.lower(), item.worktree_id))


def _build_worktree_item(
    worktree_root: str,
    path: str,
    project_index: dict[str, list[dict[str, Any]]],
) -> Optional[ProjectWorktreeItem]:
    parsed = _parse_worktree_path(worktree_root, path)
    if not parsed:
        return None
    worktree_id, project_dir_name = parsed
    matched_project = _match_worktree_project(project_index, project_dir_name)
    if not matched_project:
        return None
    return ProjectWorktreeItem(
        worktree_id=worktree_id,
        project_name=project_dir_name,
        path=path.rstrip("/"),
        project=ProjectWorktreeProjectRef(
            id=matched_project["project_id"],
            name=matched_project["project_name"],
            source_path=matched_project["source_path"],
        ),
    )


def _parse_worktree_path(worktree_root: str, path: str) -> Optional[tuple[str, str]]:
    normalized_root = worktree_root.rstrip("/")
    normalized_path = path.rstrip("/")
    prefix = f"{normalized_root}/"
    if not normalized_path.startswith(prefix):
        return None
    parts = [part for part in normalized_path[len(prefix) :].split("/") if part]
    if len(parts) != 2:
        return None
    if not WORKTREE_ID_PATTERN.fullmatch(parts[0]):
        return None
    return parts[0], parts[1]


def _match_worktree_project(
    project_index: dict[str, list[dict[str, Any]]],
    project_dir_name: str,
) -> Optional[dict[str, Any]]:
    candidates = project_index.get(project_dir_name) or project_index.get(
        project_dir_name.lower()
    )
    if not candidates:
        return None
    return sorted(candidates, key=lambda ref: ref["project_id"])[0]


def _attach_worktree_task_refs(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
    items: list[ProjectWorktreeItem],
) -> list[ProjectWorktreeItem]:
    tasks_by_id = _load_worktree_tasks_by_id(
        db=db,
        user_id=user_id,
        client_origin=client_origin,
        items=items,
    )
    if not tasks_by_id:
        return items

    result: list[ProjectWorktreeItem] = []
    for item in items:
        task = tasks_by_id.get(int(item.worktree_id))
        task_ref = _build_worktree_task_ref(item, task) if task else None
        result.append(item.model_copy(update={"task": task_ref}))
    return result


def _load_worktree_tasks_by_id(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str],
    items: list[ProjectWorktreeItem],
) -> dict[int, TaskResource]:
    worktree_ids = sorted({int(item.worktree_id) for item in items})
    if not worktree_ids:
        return {}

    query = db.query(TaskResource).filter(
        TaskResource.id.in_(worktree_ids),
        TaskResource.user_id == user_id,
        TaskResource.kind == "Task",
        TaskResource.is_active.in_(
            [TaskResource.STATE_ACTIVE, TaskResource.STATE_ARCHIVED]
        ),
    )
    if client_origin:
        query = query.filter(TaskResource.client_origin == client_origin)
    return {task.id: task for task in query.all()}


def _build_worktree_task_ref(
    item: ProjectWorktreeItem,
    task: TaskResource,
) -> Optional[ProjectWorktreeTaskRef]:
    if not item.project or task.project_id != item.project.id:
        return None

    task_workspace_path = _task_execution_workspace_path(task)
    if task_workspace_path and task_workspace_path != item.path:
        return None
    if (
        not task_workspace_path
        and _task_execution_workspace_source(task) != "git_worktree"
    ):
        return None

    return ProjectWorktreeTaskRef(
        id=task.id,
        title=_task_title(task),
        status=_task_status(task),
        project_id=task.project_id,
    )


async def _remove_worktree_directory(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    source_checkout_path: str,
    target_path: str,
) -> None:
    git_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="git_worktree_remove",
        args=[source_checkout_path, target_path],
        timeout_seconds=GIT_WORKTREE_TIMEOUT_SECONDS,
        max_output_bytes=1024 * 1024,
    )
    remove_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="remove_worktree_dir",
        args=[target_path],
        timeout_seconds=30,
        max_output_bytes=1024 * 1024,
    )
    if _command_succeeded(remove_result):
        return
    if not _command_succeeded(git_result):
        _raise_for_failed_command(git_result, "Failed to remove Git worktree")
    _raise_for_failed_command(remove_result, "Failed to remove worktree directory")


def _find_worktree_tasks(
    *,
    db: Session,
    user_id: int,
    project_id: int,
    client_origin: Optional[str],
    worktree_id: str,
    worktree_path: str,
) -> list[TaskResource]:
    query = db.query(TaskResource).filter(
        TaskResource.id == int(worktree_id),
        TaskResource.user_id == user_id,
        TaskResource.project_id == project_id,
        TaskResource.kind == "Task",
        TaskResource.is_active.in_(
            [TaskResource.STATE_ACTIVE, TaskResource.STATE_ARCHIVED]
        ),
    )
    if client_origin:
        query = query.filter(TaskResource.client_origin == client_origin)
    task = query.first()
    if not task:
        return []
    task_workspace_path = _task_execution_workspace_path(task)
    if task_workspace_path:
        return [task] if task_workspace_path == worktree_path else []
    if _task_execution_workspace_source(task) != "git_worktree":
        return []
    return [task]


def _task_execution_workspace_path(task: TaskResource) -> Optional[str]:
    """Return the persisted Task execution workspace path when present."""

    workspace = _task_execution_workspace(task)
    path = workspace.get("path")
    if not isinstance(path, str):
        return None
    return path.strip() or None


def _task_execution_workspace(task: TaskResource) -> dict[str, Any]:
    spec = _task_spec(task)
    execution = spec.get("execution")
    if not isinstance(execution, dict):
        return {}
    workspace = execution.get("workspace")
    if not isinstance(workspace, dict):
        return {}
    return workspace


def _task_execution_workspace_source(task: TaskResource) -> Optional[str]:
    workspace = _task_execution_workspace(task)
    source = workspace.get("source")
    if not isinstance(source, str):
        return None
    return source.strip() or None


def _task_json(task: TaskResource) -> dict[str, Any]:
    task_json = task.json or {}
    if not isinstance(task_json, dict):
        return {}
    return task_json


def _task_spec(task: TaskResource) -> dict[str, Any]:
    spec = _task_json(task).get("spec")
    if not isinstance(spec, dict):
        return {}
    return spec


def _task_title(task: TaskResource) -> str:
    spec = _task_spec(task)
    return str(spec.get("title") or task.name or f"Task #{task.id}")


def _task_status(task: TaskResource) -> str:
    status = _task_json(task).get("status")
    if not isinstance(status, dict):
        return "PENDING"
    return str(status.get("phase") or "PENDING")


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
    spec = _task_spec(task)
    is_group_chat = spec.get("is_group_chat", False)

    return ProjectTaskResponse(
        task_id=task_id,
        task_title=_task_title(task),
        task_status=_task_status(task),
        device_id=spec.get("device_id"),
        execution_workspace_source=_task_execution_workspace_source(task),
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
        spec = _task_spec(task)
        is_group_chat = spec.get("is_group_chat", False)

        result.append(
            ProjectTaskResponse(
                task_id=task.id,
                task_title=_task_title(task),
                task_status=_task_status(task),
                device_id=spec.get("device_id"),
                execution_workspace_source=_task_execution_workspace_source(task),
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
