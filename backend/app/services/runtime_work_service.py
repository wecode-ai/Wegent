# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for Project -> Device Workspace -> LocalTask runtime work trees."""

import re
from dataclasses import dataclass, replace
from hashlib import sha256
from types import SimpleNamespace
from typing import Any, Optional
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.kind import Kind
from app.models.project import Project
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.schemas.project import ProjectConfig
from app.schemas.runtime_work import (
    BindRuntimeTaskIMSessionsRequest,
    BindRuntimeTaskIMSessionsResponse,
    DeviceWorkspaceResponse,
    DeviceWorkspaceUpsert,
    LocalTaskSummary,
    RuntimeDeviceWorkspace,
    RuntimeProjectRef,
    RuntimeProjectWork,
    RuntimeSendRequest,
    RuntimeSendResponse,
    RuntimeTaskAddress,
    RuntimeTaskArchiveResponse,
    RuntimeTaskCreateRequest,
    RuntimeTaskCreateResponse,
    RuntimeTaskForkRequest,
    RuntimeTaskForkResponse,
    RuntimeTranscriptResponse,
    RuntimeWorkListResponse,
)
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service
from app.services.device_service import device_service
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service
from app.services.runtime_work_kind_store import (
    list_device_workspace_kinds,
    touch_device_workspace_kind,
    upsert_device_workspace_kind,
)
from app.services.object_storage import object_storage_presign_service

RUNTIME_LIST_TIMEOUT_SECONDS = 30
RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS = 30
RUNTIME_SEND_TIMEOUT_SECONDS = 600
RUNTIME_CREATE_TIMEOUT_SECONDS = 600
RUNTIME_FORK_TIMEOUT_SECONDS = 600
RUNTIME_MODEL_TYPE = "runtime"
WORKTREE_ROOT_DIR = "worktrees"
CHAT_WORKSPACE_DIR = "chats"
EXECUTOR_WORKSPACE_DIR = "workspace"
EXECUTOR_ROOT_DIR_NAMES = {"wegent-executor", ".wegent-executor"}
RUNTIME_WORKTREE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True)
class RuntimeTaskTarget:
    """Resolved device and workspace path for a runtime-local task."""

    device_id: str
    workspace_path: str
    project: Optional[Project] = None
    workspace_source: str = "local_path"


@dataclass(frozen=True)
class RuntimeWorktreePath:
    """Parsed runtime worktree path metadata."""

    worktree_id: str
    project_dir_name: str


def normalize_workspace_path(path: str) -> str:
    """Normalize device paths for stable central mapping keys."""

    normalized = path.strip()
    if not normalized:
        raise ValueError("workspacePath is required")
    if normalized == "/":
        return "/"
    return normalized.rstrip("/") or "/"


def workspace_path_hash(path: str) -> str:
    """Return a stable uniqueness key for a normalized device path."""

    return sha256(normalize_workspace_path(path).encode("utf-8")).hexdigest()


def upsert_device_workspace(
    *,
    db: Session,
    user_id: int,
    payload: DeviceWorkspaceUpsert,
) -> DeviceWorkspaceResponse:
    """Create or update the central mapping for `user + device + workspace_path`."""

    project = _get_active_project(db, user_id, payload.project_id, None)
    workspace_path = normalize_workspace_path(payload.workspace_path)
    return upsert_device_workspace_kind(
        db=db,
        user_id=user_id,
        project_id=project.id,
        payload=payload,
        workspace_path=workspace_path,
        workspace_path_hash=workspace_path_hash(workspace_path),
    )


def list_device_workspaces(
    *,
    db: Session,
    user_id: int,
    project_id: Optional[int] = None,
) -> list[DeviceWorkspaceResponse]:
    """List central device workspace mappings for a user."""

    project_ids = [project_id] if project_id is not None else None
    return list_device_workspace_kinds(
        db=db,
        user_id=user_id,
        project_ids=project_ids,
    )


async def list_runtime_work(
    *,
    db: Session,
    user_id: int,
    client_origin: Optional[str] = CLIENT_ORIGIN_WEWORK,
) -> RuntimeWorkListResponse:
    """Return runtime-native work grouped by central Project and Device Workspace."""

    projects = _list_projects(db, user_id, client_origin)
    mappings = _list_workspace_rows(db, user_id, [project.id for project in projects])
    devices = await device_service.get_all_devices(db, user_id)
    devices_by_id = {str(device.get("device_id")): device for device in devices}
    runtime_workspaces = await _list_online_runtime_workspaces(
        user_id=user_id,
        devices=devices,
    )

    workspace_items_by_project_id: dict[int, list[RuntimeDeviceWorkspace]] = {}
    total_local_tasks = 0
    mapped_keys: set[tuple[str, str]] = set()

    for project in projects:
        project_mappings = [row for row in mappings if row.project_id == project.id]
        workspace_items: list[RuntimeDeviceWorkspace] = []
        for mapping in project_mappings:
            key = (mapping.device_id, mapping.workspace_path)
            mapped_keys.add(key)
            local_tasks = runtime_workspaces.get(key, [])
            total_local_tasks += len(local_tasks)
            workspace_items.append(
                _build_device_workspace_item(
                    mapping=mapping,
                    device=devices_by_id.get(mapping.device_id),
                    local_tasks=local_tasks,
                )
            )
        configured_target = _project_runtime_target(project)
        if configured_target:
            key = (configured_target.device_id, configured_target.workspace_path)
            if key not in mapped_keys:
                mapped_keys.add(key)
                local_tasks = runtime_workspaces.get(key, [])
                total_local_tasks += len(local_tasks)
                workspace_items.append(
                    _build_project_config_workspace_item(
                        project=project,
                        target=configured_target,
                        device=devices_by_id.get(configured_target.device_id),
                        local_tasks=local_tasks,
                    )
                )
        workspace_items_by_project_id[project.id] = workspace_items

    for (device_id, workspace_path), local_tasks in runtime_workspaces.items():
        if (device_id, workspace_path) in mapped_keys:
            continue
        target = _find_project_target_for_runtime_git_info(
            projects=projects,
            mappings=mappings,
            device_id=device_id,
            local_tasks=local_tasks,
        )
        if target is not None and target.project is not None:
            mapped_keys.add((device_id, workspace_path))
            total_local_tasks += len(local_tasks)
            _append_worktree_tasks_to_source_workspace(
                workspace_items_by_project_id=workspace_items_by_project_id,
                target=target,
                device=devices_by_id.get(device_id),
                local_tasks=local_tasks,
            )
            continue

        target = _find_project_target_for_runtime_worktree(
            projects=projects,
            device_id=device_id,
            workspace_path=workspace_path,
        )
        if target is None or target.project is None:
            continue
        mapped_keys.add((device_id, workspace_path))
        total_local_tasks += len(local_tasks)
        _append_worktree_tasks_to_source_workspace(
            workspace_items_by_project_id=workspace_items_by_project_id,
            target=target,
            device=devices_by_id.get(device_id),
            local_tasks=local_tasks,
        )

    projects_response = [
        RuntimeProjectWork(
            project=_project_ref(project),
            deviceWorkspaces=workspace_items_by_project_id.get(project.id, []),
        )
        for project in projects
    ]

    unmapped: list[RuntimeDeviceWorkspace] = []
    for (device_id, workspace_path), local_tasks in runtime_workspaces.items():
        if (device_id, workspace_path) in mapped_keys:
            continue
        total_local_tasks += len(local_tasks)
        device = devices_by_id.get(device_id)
        unmapped.append(
            RuntimeDeviceWorkspace(
                id=None,
                projectId=None,
                deviceId=device_id,
                deviceName=_device_name(device, device_id),
                deviceStatus=_device_status(device),
                workspacePath=workspace_path,
                **_runtime_workspace_kind_fields(workspace_path),
                mapped=False,
                available=True,
                localTasks=local_tasks,
            )
        )

    return RuntimeWorkListResponse(
        projects=projects_response,
        unmappedDeviceWorkspaces=unmapped,
        totalLocalTasks=total_local_tasks,
    )


async def get_runtime_transcript(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> RuntimeTranscriptResponse:
    """Read a LocalTask transcript from the owning local executor."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    _touch_workspace_mapping(db, user_id, normalized_address)
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=normalized_address.device_id,
            method="runtime.tasks.transcript",
            payload=normalized_address.model_dump(by_alias=True),
            timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    _raise_runtime_rpc_failure(result)
    return RuntimeTranscriptResponse.model_validate(result)


async def send_runtime_message(
    *,
    db: Session,
    user_id: int,
    request: RuntimeSendRequest,
) -> RuntimeSendResponse:
    """Continue a LocalTask through the owning local executor."""

    address = _normalized_address(request.address)
    _ensure_owned_device(db, user_id, address.device_id)
    _touch_workspace_mapping(db, user_id, address)
    payload = {
        **address.model_dump(by_alias=True),
        "message": request.message,
    }
    if request.source:
        payload["source"] = request.source.model_dump()
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=address.device_id,
            method="runtime.tasks.send",
            payload=payload,
            timeout_seconds=RUNTIME_SEND_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_send_response(result, address.local_task_id)


async def bind_runtime_task_to_im_sessions(
    *,
    db: Session,
    user_id: int,
    request: BindRuntimeTaskIMSessionsRequest,
) -> BindRuntimeTaskIMSessionsResponse:
    """Bind private IM sessions to a device-local runtime task address."""

    address = _normalized_address(request.address)
    _ensure_owned_device(db, user_id, address.device_id)
    _touch_workspace_mapping(db, user_id, address)
    sessions = await im_session_service.load_user_sessions_by_keys(
        db,
        user_id=user_id,
        session_keys=request.session_keys,
    )
    runtime_task = address.model_dump(by_alias=True)
    for session in sessions:
        await im_session_service.bind_active_runtime_task(
            db,
            session=session,
            runtime_task=runtime_task,
        )
    notification = await im_notification_dispatcher.send_task_switched(
        db,
        sessions,
        address.local_task_id,
    )
    return BindRuntimeTaskIMSessionsResponse(
        address=address,
        boundSessionKeys=[str(session_key) for session_key in request.session_keys],
        notifiedCount=int(notification.get("sent") or 0),
    )


async def archive_runtime_task(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> RuntimeTaskArchiveResponse:
    """Archive a LocalTask through the owning local executor."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    _touch_workspace_mapping(db, user_id, normalized_address)
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=normalized_address.device_id,
            method="runtime.tasks.archive",
            payload=normalized_address.model_dump(by_alias=True),
            timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_archive_response(result, normalized_address)


async def create_runtime_task(
    *,
    db: Session,
    user_id: int,
    request: RuntimeTaskCreateRequest,
) -> RuntimeTaskCreateResponse:
    """Create a LocalTask on the selected device executor without DB Task rows."""

    target = _resolve_runtime_task_target(db, user_id, request)
    _ensure_owned_device(db, user_id, target.device_id)
    execution_request = _build_runtime_execution_request(
        db=db,
        user_id=user_id,
        request=request,
        target=target,
    )
    payload = {
        "runtime": request.runtime,
        "workspacePath": target.workspace_path,
        "message": request.message,
        "title": _runtime_task_title(request),
        "executionRequest": execution_request.to_dict(),
    }
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=target.device_id,
            method="runtime.tasks.create",
            payload=payload,
            timeout_seconds=RUNTIME_CREATE_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    return _runtime_create_response(
        result,
        request.runtime,
        target.device_id,
        target.workspace_path,
    )


async def fork_runtime_task(
    *,
    db: Session,
    user_id: int,
    request: RuntimeTaskForkRequest,
) -> RuntimeTaskForkResponse:
    """Fork a device-local LocalTask through direct transfer with storage fallback."""

    source = _normalized_address(request.source)
    target_device_id = request.target.device_id.strip()
    target_workspace_path = normalize_workspace_path(request.target.workspace_path)
    _ensure_owned_device(db, user_id, source.device_id)
    _ensure_owned_device(db, user_id, target_device_id)
    _touch_workspace_mapping(db, user_id, source)

    transfer_id = str(uuid4())

    try:
        package_result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=source.device_id,
            method="runtime.tasks.prepare_fork_transfer",
            payload={
                **source.model_dump(by_alias=True),
                "transferId": transfer_id,
            },
            timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    _raise_runtime_rpc_failure(package_result)

    fork_package = dict(package_result.get("package") or package_result)
    archive = fork_package.get("archive") if isinstance(fork_package, dict) else None
    if not isinstance(archive, dict):
        fork_package["archive"] = {"transferId": transfer_id}

    try:
        import_result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=target_device_id,
            method="runtime.tasks.import_fork",
            payload={
                "source": source.model_dump(by_alias=True),
                "workspacePath": target_workspace_path,
                "forkPackage": fork_package,
            },
            timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    if import_result.get("success") is False:
        push_transfer_id = str(uuid4())
        push_token = uuid4().hex
        try:
            receiver_result = await runtime_rpc_service.call(
                user_id=user_id,
                device_id=target_device_id,
                method="runtime.tasks.prepare_fork_receiver",
                payload={
                    "transferId": push_transfer_id,
                    "token": push_token,
                },
                timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError:
            receiver_result = {"success": False}

        if receiver_result.get("success") is not False:
            upload_urls = receiver_result.get("uploadUrls")
            try:
                push_result = await runtime_rpc_service.call(
                    user_id=user_id,
                    device_id=source.device_id,
                    method="runtime.tasks.push_fork_transfer",
                    payload={
                        "transferId": transfer_id,
                        "uploadUrls": (
                            upload_urls if isinstance(upload_urls, list) else []
                        ),
                    },
                    timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
                )
            except RuntimeRpcError:
                push_result = {"success": False}
            if push_result.get("success") is not False:
                archive = fork_package.get("archive")
                if isinstance(archive, dict):
                    archive["localTransferId"] = push_transfer_id
                else:
                    fork_package["archive"] = {"localTransferId": push_transfer_id}
                try:
                    import_result = await runtime_rpc_service.call(
                        user_id=user_id,
                        device_id=target_device_id,
                        method="runtime.tasks.import_fork",
                        payload={
                            "source": source.model_dump(by_alias=True),
                            "workspacePath": target_workspace_path,
                            "forkPackage": fork_package,
                        },
                        timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
                    )
                except RuntimeRpcError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
                    )

    if import_result.get("success") is False:
        object_key = f"runtime-task-transfers/{user_id}/{transfer_id}.tar.gz"
        upload_url, _upload_expires_at = (
            object_storage_presign_service.generate_upload_url(
                bucket=settings.WORKSPACE_ARCHIVE_BUCKET,
                object_key=object_key,
                expires_seconds=settings.PUBLISH_PRESIGNED_UPLOAD_EXPIRE_SECONDS,
            )
        )
        download_url, _download_expires_at = (
            object_storage_presign_service.generate_download_url(
                bucket=settings.WORKSPACE_ARCHIVE_BUCKET,
                object_key=object_key,
                expires_seconds=settings.PUBLISH_PRESIGNED_UPLOAD_EXPIRE_SECONDS,
            )
        )
        try:
            upload_result = await runtime_rpc_service.call(
                user_id=user_id,
                device_id=source.device_id,
                method="runtime.tasks.upload_fork_transfer",
                payload={
                    "transferId": transfer_id,
                    "uploadUrl": upload_url,
                },
                timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
            )
        _raise_runtime_rpc_failure(upload_result)
        archive = fork_package.get("archive")
        if isinstance(archive, dict):
            archive.pop("localTransferId", None)
            archive["downloadUrl"] = download_url
        else:
            fork_package["archive"] = {
                "transferId": transfer_id,
                "downloadUrl": download_url,
            }
        try:
            import_result = await runtime_rpc_service.call(
                user_id=user_id,
                device_id=target_device_id,
                method="runtime.tasks.import_fork",
                payload={
                    "source": source.model_dump(by_alias=True),
                    "workspacePath": target_workspace_path,
                    "forkPackage": fork_package,
                },
                timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
            )

    response = _runtime_fork_response(
        result=import_result,
        source=source,
        target_device_id=target_device_id,
        target_workspace_path=target_workspace_path,
        fallback_runtime=str(fork_package.get("sourceRuntime") or "codex"),
    )
    if response.accepted:
        _touch_workspace_mapping(db, user_id, response.target)
    return response


def _get_active_project(
    db: Session,
    user_id: int,
    project_id: int,
    client_origin: Optional[str],
) -> Project:
    query = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    project = query.first()
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )
    return project


def _runtime_send_response(
    result: dict[str, Any],
    local_task_id: str,
) -> RuntimeSendResponse:
    if result.get("success") is False:
        return RuntimeSendResponse(
            accepted=False,
            localTaskId=str(result.get("localTaskId") or local_task_id),
            error=str(result.get("error") or "Runtime send failed"),
        )
    return RuntimeSendResponse(
        accepted=bool(result.get("accepted", True)),
        localTaskId=str(result.get("localTaskId") or local_task_id),
        error=result.get("error"),
    )


def _runtime_archive_response(
    result: dict[str, Any],
    address: RuntimeTaskAddress,
) -> RuntimeTaskArchiveResponse:
    if result.get("success") is False:
        return RuntimeTaskArchiveResponse(
            accepted=False,
            localTaskId=str(result.get("localTaskId") or address.local_task_id),
            workspacePath=str(result.get("workspacePath") or address.workspace_path),
            error=str(result.get("error") or "Runtime archive failed"),
        )
    return RuntimeTaskArchiveResponse(
        accepted=bool(result.get("accepted", True)),
        localTaskId=str(result.get("localTaskId") or address.local_task_id),
        workspacePath=str(result.get("workspacePath") or address.workspace_path),
        error=result.get("error"),
    )


def _runtime_create_response(
    result: dict[str, Any],
    runtime: str,
    device_id: str,
    workspace_path: str,
) -> RuntimeTaskCreateResponse:
    if result.get("success") is False:
        return RuntimeTaskCreateResponse(
            accepted=False,
            deviceId=str(result.get("deviceId") or device_id),
            localTaskId=str(result.get("localTaskId") or ""),
            workspacePath=str(result.get("workspacePath") or workspace_path),
            runtime=result.get("runtime") or runtime,
            error=str(result.get("error") or "Runtime task creation failed"),
        )
    return RuntimeTaskCreateResponse(
        accepted=bool(result.get("accepted", True)),
        deviceId=str(result.get("deviceId") or device_id),
        localTaskId=str(result.get("localTaskId") or ""),
        workspacePath=str(result.get("workspacePath") or workspace_path),
        runtime=result.get("runtime") or runtime,
        error=result.get("error"),
    )


def _runtime_fork_response(
    *,
    result: dict[str, Any],
    source: RuntimeTaskAddress,
    target_device_id: str,
    target_workspace_path: str,
    fallback_runtime: str,
) -> RuntimeTaskForkResponse:
    target = RuntimeTaskAddress(
        deviceId=str(result.get("deviceId") or target_device_id),
        workspacePath=str(result.get("workspacePath") or target_workspace_path),
        localTaskId=str(result.get("localTaskId") or ""),
    )
    if result.get("success") is False:
        return RuntimeTaskForkResponse(
            accepted=False,
            source=source,
            target=target,
            runtime=str(result.get("runtime") or fallback_runtime),
            error=str(result.get("error") or "Runtime task fork failed"),
        )
    return RuntimeTaskForkResponse(
        accepted=bool(result.get("accepted", True)),
        source=source,
        target=target,
        runtime=str(result.get("runtime") or fallback_runtime),
        error=result.get("error"),
    )


def _raise_runtime_rpc_failure(result: dict[str, Any]) -> None:
    if result.get("success") is not False:
        return
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=str(result.get("error") or "Runtime RPC failed"),
    )


def _list_projects(
    db: Session,
    user_id: int,
    client_origin: Optional[str],
) -> list[Project]:
    query = db.query(Project).filter(
        Project.user_id == user_id,
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    return query.order_by(Project.sort_order.asc(), Project.id.asc()).all()


def _list_workspace_rows(
    db: Session,
    user_id: int,
    project_ids: list[int],
) -> list[DeviceWorkspaceResponse]:
    if not project_ids:
        return []
    return list_device_workspace_kinds(
        db=db,
        user_id=user_id,
        project_ids=project_ids,
    )


async def _list_online_runtime_workspaces(
    *,
    user_id: int,
    devices: list[dict[str, Any]],
) -> dict[tuple[str, str], list[LocalTaskSummary]]:
    grouped: dict[tuple[str, str], list[LocalTaskSummary]] = {}
    for device in devices:
        device_id = str(device.get("device_id") or "")
        if not device_id or _device_status(device) not in {"online", "busy"}:
            continue
        try:
            result = await runtime_rpc_service.call(
                user_id=user_id,
                device_id=device_id,
                method="runtime.tasks.list",
                payload={},
                timeout_seconds=RUNTIME_LIST_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError:
            continue
        for workspace in _iter_runtime_workspaces(result):
            workspace_path = normalize_workspace_path(workspace["workspacePath"])
            tasks = [
                LocalTaskSummary.model_validate(
                    {
                        **task,
                        **_runtime_workspace_kind_fields(
                            normalize_workspace_path(
                                str(task.get("workspacePath") or workspace_path)
                            )
                        ),
                        "workspacePath": normalize_workspace_path(
                            str(task.get("workspacePath") or workspace_path)
                        ),
                    }
                )
                for task in workspace["localTasks"]
                if isinstance(task, dict)
            ]
            if tasks:
                grouped[(device_id, workspace_path)] = tasks
    return grouped


def _iter_runtime_workspaces(result: dict[str, Any]) -> list[dict[str, Any]]:
    raw_workspaces = result.get("workspaces", [])
    if not isinstance(raw_workspaces, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in raw_workspaces:
        if not isinstance(item, dict):
            continue
        path = item.get("workspacePath") or item.get("workspace_path")
        if not isinstance(path, str) or not path.strip():
            continue
        raw_tasks = item.get("localTasks") or item.get("local_tasks") or []
        if not isinstance(raw_tasks, list):
            raw_tasks = []
        normalized.append({"workspacePath": path, "localTasks": raw_tasks})
    return normalized


def _parse_runtime_worktree_path(path: str) -> Optional[RuntimeWorktreePath]:
    parts = [part for part in normalize_workspace_path(path).split("/") if part]
    for index, part in enumerate(parts):
        if part != WORKTREE_ROOT_DIR:
            continue
        if index + 2 >= len(parts):
            continue
        worktree_id = parts[index + 1]
        project_dir_name = parts[index + 2]
        if RUNTIME_WORKTREE_ID_PATTERN.fullmatch(worktree_id):
            return RuntimeWorktreePath(
                worktree_id=worktree_id,
                project_dir_name=project_dir_name,
            )
    return None


def _runtime_workspace_kind_fields(workspace_path: str) -> dict[str, Optional[str]]:
    if _is_runtime_chat_workspace_path(workspace_path):
        return {"workspaceKind": "chat", "worktreeId": None}
    worktree = _parse_runtime_worktree_path(workspace_path)
    if not worktree:
        return {"workspaceKind": "workspace", "worktreeId": None}
    return {"workspaceKind": "worktree", "worktreeId": worktree.worktree_id}


def _is_runtime_chat_workspace_path(path: str) -> bool:
    parts = [part for part in normalize_workspace_path(path).split("/") if part]
    for index, part in enumerate(parts):
        if part != EXECUTOR_WORKSPACE_DIR or index + 1 >= len(parts):
            continue
        if parts[index + 1] != CHAT_WORKSPACE_DIR:
            continue
        previous = parts[index - 1] if index > 0 else ""
        if previous in EXECUTOR_ROOT_DIR_NAMES:
            return True
        if index == 0:
            return True
    return (
        len(parts) >= 2
        and parts[0] == EXECUTOR_WORKSPACE_DIR
        and parts[1] == CHAT_WORKSPACE_DIR
    )


def _find_project_target_for_runtime_git_info(
    *,
    projects: list[Project],
    mappings: list[DeviceWorkspaceResponse],
    device_id: str,
    local_tasks: list[LocalTaskSummary],
) -> Optional[RuntimeTaskTarget]:
    task_origin_urls = {
        _canonical_git_url(_task_git_origin_url(task))
        for task in local_tasks
        if task.runtime == "codex" and task.workspace_kind != "chat"
    }
    task_origin_urls.discard(None)
    if not task_origin_urls:
        return None

    projects_by_id = {project.id: project for project in projects}
    candidates: list[tuple[int, RuntimeTaskTarget]] = []
    for mapping in mappings:
        if mapping.device_id != device_id:
            continue
        mapping_url = _canonical_git_url(mapping.repo_url)
        project = projects_by_id.get(mapping.project_id)
        if mapping_url and mapping_url in task_origin_urls and project is not None:
            candidates.append(
                (
                    0,
                    RuntimeTaskTarget(
                        device_id=mapping.device_id,
                        workspace_path=mapping.workspace_path,
                        project=project,
                        workspace_source="local_path",
                    ),
                )
            )

    for project in projects:
        target = _project_runtime_target(project)
        if not target or target.device_id != device_id:
            continue
        project_url = _canonical_git_url(_project_git_url(project))
        if project_url and project_url in task_origin_urls:
            candidates.append((1, target))

    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda item: (item[0], item[1].project.id if item[1].project else 0),
    )[0][1]


def _task_git_origin_url(task: LocalTaskSummary) -> Optional[str]:
    git_info = task.git_info
    if not isinstance(git_info, dict):
        return None
    value = git_info.get("originUrl") or git_info.get("origin_url")
    return value if isinstance(value, str) and value.strip() else None


def _project_git_url(project: Project) -> Optional[str]:
    config = _parse_project_config(project, strict=False)
    if not config or not config.git:
        return None
    return config.git.url


def _canonical_git_url(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None

    scp_like = re.match(r"^(?:ssh://)?git@([^:/]+)[:/](.+)$", text)
    if scp_like:
        host, path = scp_like.groups()
        return _canonical_git_host_path(host, path)

    parsed = urlparse(text)
    if parsed.netloc and parsed.path:
        return _canonical_git_host_path(parsed.netloc, parsed.path)

    return text.removesuffix(".git").lower()


def _canonical_git_host_path(host: str, path: str) -> str:
    normalized_host = host.lower().removeprefix("www.")
    normalized_path = path.strip("/").removesuffix(".git").lower()
    return f"{normalized_host}/{normalized_path}"


def _find_project_target_for_runtime_worktree(
    *,
    projects: list[Project],
    device_id: str,
    workspace_path: str,
) -> Optional[RuntimeTaskTarget]:
    worktree = _parse_runtime_worktree_path(workspace_path)
    if not worktree:
        return None

    candidates: list[RuntimeTaskTarget] = []
    for project in projects:
        target = _project_runtime_target(project)
        if not target or target.device_id != device_id:
            continue
        if _path_basename(target.workspace_path).lower() == (
            worktree.project_dir_name.lower()
        ):
            candidates.append(target)
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: item.project.id if item.project else 0)[
        0
    ]


def _append_worktree_tasks_to_source_workspace(
    *,
    workspace_items_by_project_id: dict[int, list[RuntimeDeviceWorkspace]],
    target: RuntimeTaskTarget,
    device: Optional[dict[str, Any]],
    local_tasks: list[LocalTaskSummary],
) -> None:
    if target.project is None:
        return

    workspace_items = workspace_items_by_project_id.setdefault(target.project.id, [])
    for item in workspace_items:
        if (
            item.device_id == target.device_id
            and item.workspace_path == target.workspace_path
        ):
            item.local_tasks.extend(local_tasks)
            return

    workspace_items.append(
        _build_project_config_workspace_item(
            project=target.project,
            target=target,
            device=device,
            local_tasks=local_tasks,
        )
    )


def _path_basename(path: str) -> str:
    parts = [part for part in normalize_workspace_path(path).split("/") if part]
    return parts[-1] if parts else ""


def _build_device_workspace_item(
    *,
    mapping: DeviceWorkspaceResponse,
    device: Optional[dict[str, Any]],
    local_tasks: list[LocalTaskSummary],
) -> RuntimeDeviceWorkspace:
    status_value = _device_status(device)
    available = status_value in {"online", "busy"}
    return RuntimeDeviceWorkspace(
        id=mapping.id,
        projectId=mapping.project_id,
        deviceId=mapping.device_id,
        deviceName=_device_name(device, mapping.device_id),
        deviceStatus=status_value,
        workspacePath=mapping.workspace_path,
        **_runtime_workspace_kind_fields(mapping.workspace_path),
        repoUrl=mapping.repo_url,
        repoRootFingerprint=mapping.repo_root_fingerprint,
        label=mapping.label,
        mapped=True,
        available=available,
        error=None if available else "Device is offline",
        localTasks=local_tasks if available else [],
    )


def _build_project_config_workspace_item(
    *,
    project: Project,
    target: RuntimeTaskTarget,
    device: Optional[dict[str, Any]],
    local_tasks: list[LocalTaskSummary],
) -> RuntimeDeviceWorkspace:
    status_value = _device_status(device)
    available = status_value in {"online", "busy"}
    return RuntimeDeviceWorkspace(
        id=None,
        projectId=project.id,
        deviceId=target.device_id,
        deviceName=_device_name(device, target.device_id),
        deviceStatus=status_value,
        workspacePath=target.workspace_path,
        **_runtime_workspace_kind_fields(target.workspace_path),
        label=project.name,
        mapped=True,
        available=available,
        error=None if available else "Device is offline",
        localTasks=local_tasks if available else [],
    )


def _project_ref(project: Project) -> RuntimeProjectRef:
    return RuntimeProjectRef(
        id=project.id,
        name=project.name,
        description=project.description or "",
        color=project.color,
    )


def _device_name(device: Optional[dict[str, Any]], fallback: str) -> str:
    if not device:
        return fallback
    name = device.get("name")
    return str(name) if name else fallback


def _device_status(device: Optional[dict[str, Any]]) -> str:
    if not device:
        return "unavailable"
    status_value = device.get("status")
    return str(status_value) if status_value else "offline"


def _normalized_address(address: RuntimeTaskAddress) -> RuntimeTaskAddress:
    return RuntimeTaskAddress(
        deviceId=address.device_id,
        workspacePath=normalize_workspace_path(address.workspace_path),
        localTaskId=address.local_task_id.strip(),
    )


def _project_runtime_target(
    project: Project,
    *,
    strict: bool = False,
) -> Optional[RuntimeTaskTarget]:
    config = _parse_project_config(project, strict=strict)
    if not config or not config.is_workspace or not config.execution:
        return None
    if config.execution.targetType != "local" or not config.execution.deviceId:
        if strict:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Project is not configured for local runtime execution",
            )
        return None

    workspace_source = "local_path"
    workspace_path: Optional[str]
    if config.workspace:
        workspace_source = config.workspace.source
        if config.workspace.source == "git":
            workspace_path = (
                f"projects/{config.workspace.checkoutPath}"
                if config.workspace.checkoutPath
                else None
            )
        else:
            workspace_path = config.workspace.localPath
    else:
        workspace_path = f"project{project.id}"

    if not workspace_path:
        if strict:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Project workspace path is not configured",
            )
        return None

    return RuntimeTaskTarget(
        device_id=config.execution.deviceId,
        workspace_path=normalize_workspace_path(workspace_path),
        project=project,
        workspace_source=workspace_source,
    )


def _parse_project_config(
    project: Project,
    *,
    strict: bool,
) -> Optional[ProjectConfig]:
    try:
        return ProjectConfig.model_validate(project.config or {})
    except Exception as exc:
        if strict:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid project runtime config: {exc}",
            )
        return None


def _resolve_runtime_task_target(
    db: Session,
    user_id: int,
    request: RuntimeTaskCreateRequest,
) -> RuntimeTaskTarget:
    if request.project_id is not None:
        project = _get_active_project(
            db,
            user_id,
            request.project_id,
            CLIENT_ORIGIN_WEWORK,
        )
        target = _project_runtime_target(project, strict=True)
        if target:
            return _apply_requested_workspace_source(target, request)

    if request.device_id and request.workspace_path:
        return RuntimeTaskTarget(
            device_id=request.device_id.strip(),
            workspace_path=normalize_workspace_path(request.workspace_path),
            project=None,
            workspace_source="local_path",
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="projectId or deviceId + workspacePath is required",
    )


def _runtime_task_title(request: RuntimeTaskCreateRequest) -> str:
    title = (request.title or "").strip()
    if title:
        return title
    first_line = (
        request.message.strip().splitlines()[0] if request.message.strip() else ""
    )
    return first_line[:80] or "Untitled runtime task"


def _build_runtime_execution_request(
    *,
    db: Session,
    user_id: int,
    request: RuntimeTaskCreateRequest,
    target: RuntimeTaskTarget,
):
    """Build an executor request from CRD config without persisting Task rows."""

    from app.services.execution import TaskRequestBuilder

    user = _get_user(db, user_id)
    team = _get_team(db, user_id, request.team_id)
    task_id, subtask_id = _runtime_execution_ids()
    task = _runtime_task_context(
        user_id=user_id,
        task_id=task_id,
        request=request,
        target=target,
        team=team,
    )
    subtask = _runtime_assistant_context(
        user_id=user_id,
        task_id=task_id,
        subtask_id=subtask_id,
        request=request,
        team=team,
    )
    payload = _runtime_execution_payload(request)
    runtime_model_config, override_model_name, force_override = _runtime_model_override(
        request
    )
    execution_request = TaskRequestBuilder(db).build(
        subtask=subtask,
        task=task,
        user=user,
        team=team,
        message=request.message,
        preload_skills=request.additional_skills,
        override_model_name=override_model_name,
        force_override=force_override,
        runtime_model_config=runtime_model_config,
        web_runtime_guidance=True,
    )
    _apply_runtime_task_target(execution_request, target)
    _apply_runtime_model_options(db, execution_request, user, payload)
    _apply_runtime_attachments(db, execution_request, user_id, request.attachment_ids)
    return execution_request


def _runtime_execution_ids() -> tuple[int, int]:
    base_id = 10_000_000_000_000 + (uuid4().int % 8_000_000_000_000)
    return base_id, base_id + 1


def _runtime_task_context(
    *,
    user_id: int,
    task_id: int,
    request: RuntimeTaskCreateRequest,
    target: RuntimeTaskTarget,
    team: Kind,
) -> SimpleNamespace:
    title = _runtime_task_title(request)
    workspace_spec = _runtime_workspace_spec(request, target)
    return SimpleNamespace(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"runtime-{task_id}",
        namespace="default",
        project_id=target.project.id if target.project else 0,
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_group_chat=False,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": f"runtime-{task_id}",
                "namespace": "default",
                "labels": (
                    {"projectId": str(target.project.id)} if target.project else {}
                ),
            },
            "spec": {
                "title": title,
                "prompt": request.message,
                "teamRef": {"name": team.name, "namespace": team.namespace},
                "workspaceRef": {"name": "runtime-local", "namespace": "default"},
                "is_group_chat": False,
                "device_id": target.device_id,
                "execution": {
                    "workspace": workspace_spec,
                },
            },
        },
    )


def _runtime_assistant_context(
    *,
    user_id: int,
    task_id: int,
    subtask_id: int,
    request: RuntimeTaskCreateRequest,
    team: Kind,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id,
        team_id=team.id,
        title=f"{_runtime_task_title(request)} - Assistant",
        bot_ids=[],
        prompt=request.message,
        message_id=None,
        executor_name=None,
    )


def _runtime_execution_payload(
    request: RuntimeTaskCreateRequest,
) -> SimpleNamespace:
    return SimpleNamespace(
        model_options=request.model_options,
        additional_skills=request.additional_skills,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )


def _apply_requested_workspace_source(
    target: RuntimeTaskTarget,
    request: RuntimeTaskCreateRequest,
) -> RuntimeTaskTarget:
    workspace = _request_execution_workspace(request)
    source = workspace.get("source") if workspace else None
    if source == "git_worktree":
        return replace(target, workspace_source="git_worktree")
    return target


def _runtime_workspace_spec(
    request: RuntimeTaskCreateRequest,
    target: RuntimeTaskTarget,
) -> dict[str, Any]:
    workspace_spec: dict[str, Any] = {
        "source": target.workspace_source,
        "path": target.workspace_path,
    }
    requested_workspace = _request_execution_workspace(request)
    if requested_workspace:
        branch = requested_workspace.get("branch")
        if isinstance(branch, str) and branch.strip():
            workspace_spec["branch"] = branch.strip()
    return workspace_spec


def _request_execution_workspace(
    request: RuntimeTaskCreateRequest,
) -> dict[str, Any]:
    execution = request.execution
    if not isinstance(execution, dict):
        return {}
    workspace = execution.get("workspace")
    return workspace if isinstance(workspace, dict) else {}


def _runtime_model_override(
    request: RuntimeTaskCreateRequest,
) -> tuple[Optional[dict[str, Any]], Optional[str], bool]:
    if not request.model_id:
        return None, None, False
    if request.runtime == "codex" and request.model_type == RUNTIME_MODEL_TYPE:
        from app.services.chat.trigger.unified import _build_codex_runtime_model_config

        return _build_codex_runtime_model_config(request.model_id), None, False
    return None, request.model_id, True


def _apply_runtime_task_target(
    execution_request,
    target: RuntimeTaskTarget,
) -> None:
    execution_request.device_id = target.device_id
    execution_request.execution_target_type = "local"
    execution_request.workspace_source = target.workspace_source
    execution_request.project_workspace_path = target.workspace_path
    project_workspace = dict((execution_request.workspace or {}).get("project") or {})
    project_workspace.update(
        {
            "project_id": target.project.id if target.project else None,
            "workspace_source": target.workspace_source,
            "project_workspace_path": target.workspace_path,
            "execution_target_type": "local",
            "device_id": target.device_id,
            "local_path": target.workspace_path,
        }
    )
    workspace = dict(execution_request.workspace or {})
    workspace["project"] = project_workspace
    execution_request.workspace = workspace


def _apply_runtime_model_options(
    db: Session,
    execution_request,
    user: User,
    payload: SimpleNamespace,
) -> None:
    from app.services.chat.trigger.unified import (
        _apply_user_runtime_config,
        _reasoning_from_model_options,
        _service_tier_from_model_options,
    )

    reasoning_config = _reasoning_from_model_options(payload)
    if reasoning_config:
        execution_request.model_config["reasoning"] = reasoning_config
    service_tier = _service_tier_from_model_options(payload)
    if service_tier:
        execution_request.model_config["service_tier"] = service_tier
    _apply_user_runtime_config(db, execution_request, user)
    execution_request.reasoning_config = (
        reasoning_config or execution_request.model_config.get("reasoning")
    )


def _apply_runtime_attachments(
    db: Session,
    execution_request,
    user_id: int,
    attachment_ids: list[int],
) -> None:
    """Attach existing uploaded contexts without linking them to transient subtasks."""

    if not attachment_ids:
        return

    contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(attachment_ids),
            SubtaskContext.user_id == user_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            SubtaskContext.status == ContextStatus.READY.value,
        )
        .order_by(SubtaskContext.id.asc())
        .all()
    )
    execution_request.attachments = [
        {
            "id": context.id,
            "original_filename": context.original_filename,
            "mime_type": context.mime_type,
            "file_size": context.file_size,
            "subtask_id": context.subtask_id,
        }
        for context in contexts
    ]


def _get_user(db: Session, user_id: int) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return user


def _get_team(db: Session, user_id: int, team_id: int) -> Kind:
    team = (
        db.query(Kind)
        .filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.user_id.in_([user_id, 0]),
            Kind.is_active.is_(True),
        )
        .first()
    )
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Team not found",
        )
    return team


def _ensure_owned_device(db: Session, user_id: int, device_id: str) -> None:
    if not device_service.get_device_by_device_id(db, user_id, device_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found or access denied",
        )


def _touch_workspace_mapping(
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> Optional[DeviceWorkspaceResponse]:
    return touch_device_workspace_kind(
        db=db,
        user_id=user_id,
        device_id=address.device_id,
        workspace_path_hash=workspace_path_hash(address.workspace_path),
    )
