# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for binding local Codex threads to Wework tasks."""

import hashlib
import posixpath
import re
from dataclasses import dataclass
from typing import Optional, Sequence

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.constants import (
    CLIENT_ORIGIN_WEWORK,
    LABEL_LOCAL_CODEX_DEVICE_ID,
    LABEL_LOCAL_CODEX_THREAD_ID,
    TASK_SOURCE_LOCAL_CODEX_THREAD,
    WORKSPACE_SOURCE_LOCAL_CODEX_THREAD,
)
from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.project import ProjectCreate
from app.services import project_service
from app.services.chat.storage.task_manager import (
    TaskCreationParams,
    create_new_task,
    create_user_subtask,
)
from app.services.device_service import device_service
from app.services.task_status import mark_task_completed
from app.stores.tasks import task_store

CODEX_THREAD_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


@dataclass(frozen=True)
class LocalCodexBinding:
    """Result of a local Codex thread bind operation."""

    task: TaskResource
    task_id: int
    thread_id: str
    device_id: str
    created: bool


def normalize_codex_thread_id(thread_id: str) -> str:
    """Validate and normalize a Codex thread id."""

    normalized = (thread_id or "").strip()
    if not CODEX_THREAD_ID_PATTERN.fullmatch(normalized):
        raise ValueError("Invalid Codex thread id")
    return normalized


def get_local_codex_binding(task: TaskResource) -> Optional[dict[str, str]]:
    """Return local Codex binding labels for a task when present."""

    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    execution = spec.get("execution") if isinstance(spec.get("execution"), dict) else {}
    workspace = (
        execution.get("workspace")
        if isinstance(execution.get("workspace"), dict)
        else {}
    )
    if workspace.get("source") != WORKSPACE_SOURCE_LOCAL_CODEX_THREAD:
        return None

    labels = (
        task_json.get("metadata", {}).get("labels", {})
        if isinstance(task_json.get("metadata"), dict)
        else {}
    )
    thread_id = labels.get(LABEL_LOCAL_CODEX_THREAD_ID)
    device_id = labels.get(LABEL_LOCAL_CODEX_DEVICE_ID)
    if not isinstance(thread_id, str) or not isinstance(device_id, str):
        return None
    if not thread_id.strip() or not device_id.strip():
        return None
    return {"thread_id": thread_id.strip(), "device_id": device_id.strip()}


def find_bound_local_codex_task(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    thread_id: str,
    states: Optional[Sequence[int]] = None,
) -> Optional[TaskResource]:
    """Find an active Wework task already bound to the device/thread pair."""

    tasks = task_store.list_owned_tasks_by_states(
        db,
        user_id=user_id,
        states=TaskResource.is_active_query() if states is None else states,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )
    for task in tasks:
        binding = get_local_codex_binding(task)
        if not binding:
            continue
        if binding["thread_id"] == thread_id and binding["device_id"] == device_id:
            return task
    return None


def bind_local_codex_thread(
    db: Session,
    *,
    user: User,
    team: Kind,
    device_id: str,
    thread_id: str,
    title: Optional[str] = None,
    cwd: Optional[str] = None,
) -> LocalCodexBinding:
    """Bind a local Codex thread to a Wework task, reusing an existing bind."""

    normalized_thread_id = normalize_codex_thread_id(thread_id)
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise ValueError("Device id is required")

    device = device_service.get_device_by_device_id(db, user.id, normalized_device_id)
    if not device:
        raise ValueError("Device not found or access denied")

    project_id = _resolve_local_path_project_id(
        db=db,
        user=user,
        team=team,
        device_id=normalized_device_id,
        cwd=cwd,
    )

    existing = find_bound_local_codex_task(
        db,
        user_id=user.id,
        device_id=normalized_device_id,
        thread_id=normalized_thread_id,
        states=[
            *TaskResource.is_active_query(),
            TaskResource.STATE_ARCHIVED,
        ],
    )
    if existing:
        if existing.is_active == TaskResource.STATE_ARCHIVED:
            _restore_archived_binding_task(existing)
            db.commit()
            db.refresh(existing)
        _move_binding_task_to_project(
            db=db,
            task=existing,
            project_id=project_id,
            user_id=user.id,
        )
        return LocalCodexBinding(
            task=existing,
            task_id=existing.id,
            thread_id=normalized_thread_id,
            device_id=normalized_device_id,
            created=False,
        )

    _release_deleted_binding_task_names(
        db,
        user_id=user.id,
        device_id=normalized_device_id,
        thread_id=normalized_thread_id,
    )

    display_title = _build_display_title(normalized_thread_id, title)
    summary = _build_binding_summary(
        thread_id=normalized_thread_id,
        device_id=normalized_device_id,
        cwd=cwd,
    )
    execution_workspace = {"source": WORKSPACE_SOURCE_LOCAL_CODEX_THREAD}
    normalized_cwd = cwd.strip() if isinstance(cwd, str) and cwd.strip() else None
    if normalized_cwd:
        execution_workspace["path"] = normalized_cwd

    task = create_new_task(
        db,
        user,
        team,
        TaskCreationParams(
            message=summary,
            title=display_title,
            task_type="code",
            device_id=normalized_device_id,
            project_id=project_id,
            execution_workspace=execution_workspace,
            task_name=_build_binding_task_name(
                device_id=normalized_device_id,
                thread_id=normalized_thread_id,
            ),
            client_origin=CLIENT_ORIGIN_WEWORK,
            source=TASK_SOURCE_LOCAL_CODEX_THREAD,
        ),
    )
    _apply_binding_labels(
        task,
        device_id=normalized_device_id,
        thread_id=normalized_thread_id,
    )
    create_user_subtask(
        db=db,
        subtask_user_id=user.id,
        sender_user_id=user.id,
        task_id=task.id,
        team_id=team.id,
        bot_ids=[],
        message=summary,
        next_message_id=1,
        parent_id=0,
    )
    mark_task_completed(task)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = find_bound_local_codex_task(
            db,
            user_id=user.id,
            device_id=normalized_device_id,
            thread_id=normalized_thread_id,
            states=[
                *TaskResource.is_active_query(),
                TaskResource.STATE_ARCHIVED,
            ],
        )
        if existing:
            if existing.is_active == TaskResource.STATE_ARCHIVED:
                _restore_archived_binding_task(existing)
                db.commit()
                db.refresh(existing)
            _move_binding_task_to_project(
                db=db,
                task=existing,
                project_id=project_id,
                user_id=user.id,
            )
            return LocalCodexBinding(
                task=existing,
                task_id=existing.id,
                thread_id=normalized_thread_id,
                device_id=normalized_device_id,
                created=False,
            )
        raise
    db.refresh(task)

    return LocalCodexBinding(
        task=task,
        task_id=task.id,
        thread_id=normalized_thread_id,
        device_id=normalized_device_id,
        created=True,
    )


def _apply_binding_labels(
    task: TaskResource,
    *,
    device_id: str,
    thread_id: str,
) -> None:
    task_json = task.json if isinstance(task.json, dict) else {}
    metadata = task_json.setdefault("metadata", {})
    labels = metadata.setdefault("labels", {})
    labels.update(
        {
            "source": TASK_SOURCE_LOCAL_CODEX_THREAD,
            LABEL_LOCAL_CODEX_THREAD_ID: thread_id,
            LABEL_LOCAL_CODEX_DEVICE_ID: device_id,
        }
    )
    task.json = task_json


def _build_display_title(thread_id: str, title: Optional[str]) -> str:
    display_title = title.strip() if isinstance(title, str) and title.strip() else None
    return display_title or f"Codex thread {thread_id[:8]}"


def _build_binding_task_name(*, device_id: str, thread_id: str) -> str:
    device_digest = hashlib.sha256(device_id.encode("utf-8")).hexdigest()[:12]
    compact_thread_id = thread_id.replace("-", "").lower()
    return f"local-codex-{device_digest}-{compact_thread_id}"


def _resolve_local_path_project_id(
    *,
    db: Session,
    user: User,
    team: Kind,
    device_id: str,
    cwd: Optional[str],
) -> int:
    normalized_cwd = cwd.strip() if isinstance(cwd, str) and cwd.strip() else None
    if not normalized_cwd:
        return 0

    worktree_project = project_service.find_wework_project_for_worktree_path(
        db=db,
        user_id=user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
        device_id=device_id,
        worktree_path=normalized_cwd,
    )
    if worktree_project:
        return worktree_project.id

    project = project_service.create_project(
        db,
        ProjectCreate(
            name=_build_project_name(normalized_cwd),
            client_origin=CLIENT_ORIGIN_WEWORK,
            config={
                "mode": "workspace",
                "execution": {"targetType": "local", "deviceId": device_id},
                "team": {
                    "id": team.id,
                    "name": team.name,
                    "namespace": team.namespace,
                },
                "workspace": {
                    "source": "local_path",
                    "localPath": normalized_cwd,
                },
            },
        ),
        user.id,
    )
    return project.id


def _build_project_name(cwd: str) -> str:
    stripped = cwd.rstrip("/") or cwd
    basename = posixpath.basename(stripped)
    return basename or "Local Codex"


def _move_binding_task_to_project(
    *,
    db: Session,
    task: TaskResource,
    project_id: int,
    user_id: int,
) -> None:
    if not project_id or task.project_id == project_id:
        return
    project_service.add_task_to_project(
        db,
        project_id=project_id,
        task_id=task.id,
        user_id=user_id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )
    db.refresh(task)


def _restore_archived_binding_task(task: TaskResource) -> None:
    task.is_active = TaskResource.STATE_ACTIVE


def _release_deleted_binding_task_names(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    thread_id: str,
) -> None:
    deleted_tasks = task_store.list_owned_tasks_by_states(
        db,
        user_id=user_id,
        states=[TaskResource.STATE_DELETED],
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    released_any = False
    for deleted in deleted_tasks:
        binding = get_local_codex_binding(deleted)
        if not binding:
            continue
        if binding["thread_id"] != thread_id or binding["device_id"] != device_id:
            continue

        released_name = f"released-local-codex-{deleted.id}"
        deleted.name = released_name
        task_json = deleted.json if isinstance(deleted.json, dict) else {}
        metadata = task_json.setdefault("metadata", {})
        metadata["name"] = released_name
        deleted.json = task_json
        released_any = True

    if not released_any:
        return
    db.flush()


def _build_binding_summary(
    *,
    thread_id: str,
    device_id: str,
    cwd: Optional[str],
) -> str:
    lines = [
        "Bound to an existing local Codex thread.",
        f"Thread ID: {thread_id}",
        f"Device ID: {device_id}",
    ]
    normalized_cwd = cwd.strip() if isinstance(cwd, str) and cwd.strip() else None
    if normalized_cwd:
        lines.append(f"Working directory: {normalized_cwd}")
    return "\n".join(lines)
