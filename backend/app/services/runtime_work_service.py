# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for Project -> Device Workspace -> LocalTask runtime work trees."""

import asyncio
import json
import logging
import posixpath
import re
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from hashlib import sha256
from types import SimpleNamespace
from typing import Any, Optional
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.models.project import Project
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.schemas.project import ProjectConfig
from app.schemas.runtime_work import (
    ArchivedConversationItem,
    ArchivedConversationProjectGroup,
    ArchivedConversationsListRequest,
    ArchivedConversationsListResponse,
    BindRuntimeTaskIMSessionsRequest,
    BindRuntimeTaskIMSessionsResponse,
    DeviceWorkspacePrepareRequest,
    DeviceWorkspacePrepareResponse,
    DeviceWorkspaceResponse,
    DeviceWorkspaceUpsert,
    LocalTaskSummary,
    RuntimeArchivedConversationBulkRequest,
    RuntimeArchivedConversationBulkResponse,
    RuntimeArchiveProjectConversationsRequest,
    RuntimeDeviceWorkspace,
    RuntimeFileChangesRevertRequest,
    RuntimeFileChangesRevertResponse,
    RuntimeGlobalIMNotificationUpdateRequest,
    RuntimeGuidanceRequest,
    RuntimeGuidanceResponse,
    RuntimeIMNotificationSession,
    RuntimeIMNotificationSettingsResponse,
    RuntimeProjectRef,
    RuntimeProjectWork,
    RuntimeSendRequest,
    RuntimeSendResponse,
    RuntimeTaskAddress,
    RuntimeTaskArchiveResponse,
    RuntimeTaskCancelResponse,
    RuntimeTaskCreateRequest,
    RuntimeTaskCreateResponse,
    RuntimeTaskForkRequest,
    RuntimeTaskForkResponse,
    RuntimeTaskIMNotificationSubscription,
    RuntimeTaskIMNotificationSubscriptionRequest,
    RuntimeTaskIMNotificationSubscriptionResponse,
    RuntimeTaskRenameRequest,
    RuntimeTranscriptRequest,
    RuntimeTranscriptResponse,
    RuntimeWorkListResponse,
    RuntimeWorkSearchItem,
    RuntimeWorkSearchProjectRef,
    RuntimeWorkSearchRequest,
    RuntimeWorkSearchResponse,
    RuntimeWorkspaceOpenRequest,
    RuntimeWorkspaceOpenResponse,
    RuntimeWorkspaceRemoveRequest,
    RuntimeWorkspaceRenameRequest,
    RuntimeWorkspaceSearchRequest,
    RuntimeWorkspaceSearchResponse,
)
from app.schemas.turn_file_changes import TurnFileChangesSummary
from app.services.device.command_service import execute_configured_device_command
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service
from app.services.device_service import device_service
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service
from app.services.object_storage import object_storage_presign_service
from app.services.runtime_work_kind_store import (
    deactivate_device_workspace_kind,
    get_device_workspace_kind_by_id,
    list_device_workspace_kinds,
    touch_device_workspace_kind,
    upsert_device_workspace_kind,
)

logger = logging.getLogger(__name__)

RUNTIME_LIST_TIMEOUT_SECONDS = 30
RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS = 30
RUNTIME_SEARCH_TIMEOUT_SECONDS = 30
RUNTIME_SEND_TIMEOUT_SECONDS = 600
RUNTIME_CANCEL_TIMEOUT_SECONDS = 30
RUNTIME_CREATE_TIMEOUT_SECONDS = 600
RUNTIME_WORKSPACE_OPEN_TIMEOUT_SECONDS = 60
RUNTIME_FORK_TIMEOUT_SECONDS = 600
DEVICE_WORKSPACE_PREPARE_TIMEOUT_SECONDS = 600
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


@dataclass(frozen=True)
class RuntimeForkWorkspaceTransfer:
    """Target workspace details for an optimized runtime fork transfer."""

    mode: str
    target_workspace_path: str
    source_commit: str


@dataclass(frozen=True)
class RuntimeWorkspaceListing:
    """Executor workspace listing plus local task summaries."""

    local_tasks: list[LocalTaskSummary]
    order_index: int = 0
    label: Optional[str] = None
    workspace_source: Optional[str] = None
    remote_host_id: Optional[str] = None


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


async def prepare_device_workspace(
    *,
    db: Session,
    user_id: int,
    payload: DeviceWorkspacePrepareRequest,
) -> DeviceWorkspacePrepareResponse:
    """Prepare a project child folder on one device and persist its mapping."""

    project = _get_active_project(db, user_id, payload.project_id, None)
    workspace_path = normalize_workspace_path(payload.workspace_path)
    config = ProjectConfig.model_validate(project.config or {})
    repo_url = config.git.url if config.is_workspace and config.git else None
    prepared_action = (
        await _prepare_git_workspace_path(
            db=db,
            user_id=user_id,
            device_id=payload.device_id,
            workspace_path=workspace_path,
            git_url=repo_url,
            branch=config.git.branch if config.git else None,
            git_domain=config.git.domain if config.git else None,
            action=payload.action,
        )
        if repo_url
        else await _prepare_plain_workspace_path(
            db=db,
            user_id=user_id,
            device_id=payload.device_id,
            workspace_path=workspace_path,
            action=payload.action,
        )
    )
    await _register_prepared_runtime_workspace(
        user_id=user_id,
        device_id=payload.device_id,
        workspace_path=workspace_path,
        project_name=project.name,
    )
    mapping = upsert_device_workspace(
        db=db,
        user_id=user_id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId=payload.device_id,
            workspacePath=workspace_path,
            repoUrl=repo_url,
            label=payload.label,
        ),
    )
    return DeviceWorkspacePrepareResponse(
        mapping=mapping,
        preparedAction=prepared_action,
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


def delete_device_workspace(
    *,
    db: Session,
    user_id: int,
    project_id: int,
    device_id: str,
    workspace_path: str,
) -> bool:
    """Deactivate one Project-to-device workspace mapping."""

    project = _get_active_project(db, user_id, project_id, None)
    normalized_path = normalize_workspace_path(workspace_path)
    return deactivate_device_workspace_kind(
        db=db,
        user_id=user_id,
        project_id=project.id,
        device_id=device_id.strip(),
        workspace_path_hash=workspace_path_hash(normalized_path),
    )


async def list_runtime_work(
    *,
    db: Session,
    user_id: int,
) -> RuntimeWorkListResponse:
    """Return runtime-native work grouped by executor workspace."""

    devices = await device_service.get_all_devices(db, user_id)
    devices_by_id = {str(device.get("device_id")): device for device in devices}
    runtime_workspaces = await _list_online_runtime_workspaces(
        user_id=user_id,
        devices=devices,
    )
    device_order = _runtime_device_order(devices)

    projects: list[RuntimeProjectWork] = []
    conversations: list[RuntimeDeviceWorkspace] = []
    total_tasks = 0

    for (device_id, workspace_path), workspace_listing in sorted(
        runtime_workspaces.items(),
        key=lambda item: _runtime_workspace_order_key(item, device_order),
    ):
        tasks = workspace_listing.local_tasks
        total_tasks += len(tasks)
        device = devices_by_id.get(device_id)
        workspace_kind_fields = _runtime_workspace_kind_fields_from_tasks(
            workspace_path,
            tasks,
        )
        workspace = RuntimeDeviceWorkspace(
            id=None,
            projectId=None,
            deviceId=device_id,
            deviceName=_device_name(device, device_id),
            deviceStatus=_device_status(device),
            workspacePath=workspace_path,
            **workspace_kind_fields,
            label=workspace_listing.label,
            workspaceSource=workspace_listing.workspace_source,
            remoteHostId=workspace_listing.remote_host_id,
            mapped=True,
            available=True,
            tasks=tasks,
        )
        if workspace.workspace_kind == "chat":
            conversations.append(workspace)
            continue
        project_ref = _runtime_project_ref_from_workspace(
            device_id,
            workspace_path,
            label=workspace_listing.label,
        )
        projects.append(
            RuntimeProjectWork(
                project=project_ref,
                deviceWorkspaces=[workspace],
            )
        )

    return RuntimeWorkListResponse(
        projects=projects,
        chats=conversations,
        totalTasks=total_tasks,
    )


async def get_runtime_transcript(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTranscriptRequest,
) -> RuntimeTranscriptResponse:
    """Read a LocalTask transcript from the owning local executor."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    _touch_workspace_mapping(db, user_id, normalized_address)
    payload = _runtime_transcript_payload(address, normalized_address)
    started_at = time.perf_counter()
    logger.info(
        "[RuntimeWork] Requesting runtime transcript: user_id=%s device_id=%s local_task_id=%s workspace_path=%s limit=%s before_cursor=%s include_full_content=%s",
        user_id,
        normalized_address.device_id,
        normalized_address.local_task_id,
        normalized_address.workspace_path,
        payload.get("limit"),
        payload.get("beforeCursor"),
        payload.get("includeFullContent"),
    )
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=normalized_address.device_id,
            method="runtime.tasks.transcript",
            payload=payload,
            timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.warning(
            "[RuntimeWork] Runtime transcript RPC failed: user_id=%s device_id=%s local_task_id=%s elapsed_ms=%s detail=%s",
            user_id,
            normalized_address.device_id,
            normalized_address.local_task_id,
            elapsed_ms,
            str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    _raise_runtime_rpc_failure(result)
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    logger.info(
        "[RuntimeWork] Runtime transcript RPC completed: user_id=%s device_id=%s local_task_id=%s elapsed_ms=%s message_count=%s messages_with_subtask=%s messages_with_file_changes=%s has_more_before=%s before_cursor=%s",
        user_id,
        normalized_address.device_id,
        normalized_address.local_task_id,
        elapsed_ms,
        (
            len(result.get("messages", []))
            if isinstance(result.get("messages"), list)
            else None
        ),
        _runtime_message_count(result, "subtaskId"),
        _runtime_message_count(result, "fileChanges"),
        result.get("hasMoreBefore"),
        result.get("beforeCursor"),
    )
    return RuntimeTranscriptResponse.model_validate(result)


async def search_runtime_work(
    *,
    db: Session,
    user_id: int,
    request: RuntimeWorkSearchRequest,
) -> RuntimeWorkSearchResponse:
    """Search runtime transcripts on online or busy devices owned by the user."""

    devices = await device_service.get_all_devices(db, user_id)
    searchable_devices: list[tuple[str, dict[str, Any]]] = []
    for device in devices:
        device_id = str(device.get("device_id") or "")
        if not device_id or _device_status(device) not in {"online", "busy"}:
            continue
        searchable_devices.append((device_id, device))

    device_results = await asyncio.gather(
        *(
            _search_runtime_work_device(
                user_id=user_id,
                device_id=device_id,
                device=device,
                request=request,
            )
            for device_id, device in searchable_devices
        )
    )
    items = [item for device_items in device_results for item in device_items]

    items.sort(
        key=lambda item: _parse_optional_timestamp(item.updated_at),
        reverse=True,
    )
    return RuntimeWorkSearchResponse(items=items[: request.limit])


async def _search_runtime_work_device(
    *,
    user_id: int,
    device_id: str,
    device: dict[str, Any],
    request: RuntimeWorkSearchRequest,
) -> list[RuntimeWorkSearchItem]:
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.tasks.search",
            payload={
                "query": request.query,
                "limit": request.limit,
                "includeArchived": request.include_archived,
            },
            timeout_seconds=RUNTIME_SEARCH_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError:
        return []
    if result.get("success") is False:
        return []
    return _runtime_search_items_from_result(
        result=result,
        device=device,
        device_id=device_id,
        project_id=request.project_id,
    )


async def revert_runtime_file_changes(
    *,
    db: Session,
    user_id: int,
    request: RuntimeFileChangesRevertRequest,
) -> RuntimeFileChangesRevertResponse:
    """Revert a native runtime file-change artifact on the owning device."""

    address = _normalized_address(request.address)
    _ensure_owned_device(db, user_id, address.device_id)
    summary = TurnFileChangesSummary.model_validate(
        _runtime_file_changes_summary_payload(request.file_changes)
    )
    if summary.device_id != address.device_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Runtime file changes device does not match the task address",
        )
    if summary.status == "reverted":
        return RuntimeFileChangesRevertResponse(
            fileChanges=summary.model_dump(mode="json")
        )

    result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=address.device_id,
        command_key="turn_file_changes_revert",
        path=summary.workspace_path,
        args=[summary.artifact_id],
        timeout_seconds=30,
        max_output_bytes=5 * 1024 * 1024,
    )
    payload = result.get("stdout") if isinstance(result, dict) else None
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Device returned malformed artifact output",
        )
    if payload.get("success") is not True:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(payload.get("error") or "Runtime file changes revert failed"),
        )
    if payload.get("status") == "conflicted":
        updated = _runtime_file_changes_with_status(summary, "conflicted")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"file_changes": updated, "message": "Patch does not apply"},
        )
    if payload.get("status") == "artifact_missing":
        updated = _runtime_file_changes_with_status(summary, "artifact_missing")
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"file_changes": updated, "message": "Artifact is missing"},
        )
    if payload.get("status") != "reverted":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Device returned an invalid revert result",
        )

    return RuntimeFileChangesRevertResponse(
        fileChanges=_runtime_file_changes_with_status(summary, "reverted")
    )


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
        **_runtime_task_address_payload(address),
        "message": request.message,
    }
    attachments = _runtime_attachment_payloads(db, user_id, request.attachment_ids)
    if attachments:
        payload["attachments"] = attachments
    if request.source:
        payload["source"] = request.source.model_dump()
    if request.request_user_input_response is not None:
        payload["requestUserInputResponse"] = request.request_user_input_response
    if request.additional_context:
        payload["additionalContext"] = request.additional_context
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


async def send_runtime_guidance(
    *,
    db: Session,
    user_id: int,
    request: RuntimeGuidanceRequest,
) -> RuntimeGuidanceResponse:
    """Steer an active LocalTask turn through the owning local executor."""

    address = _normalized_address(request.address)
    _ensure_owned_device(db, user_id, address.device_id)
    _touch_workspace_mapping(db, user_id, address)
    payload = {
        **_runtime_task_address_payload(address),
        "message": request.message,
    }
    attachments = _runtime_attachment_payloads(db, user_id, request.attachment_ids)
    if attachments:
        payload["attachments"] = attachments
    if request.client_guidance_id:
        payload["clientGuidanceId"] = request.client_guidance_id
    if request.additional_context:
        payload["additionalContext"] = request.additional_context
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=address.device_id,
            method="runtime.tasks.guidance",
            payload=payload,
            timeout_seconds=RUNTIME_SEND_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_guidance_response(result, address.local_task_id)


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
    runtime_task = _runtime_task_address_payload(address)
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


async def get_im_notification_settings(
    *,
    db: Session,
    user_id: int,
) -> RuntimeIMNotificationSettingsResponse:
    """Return global and task-level IM notification settings for runtime tasks."""

    global_settings = await im_session_service.get_global_notification_settings(user_id)
    global_session = (
        await _load_user_im_session(user_id, global_settings.session_key)
        if global_settings.session_key
        else None
    )
    subscriptions = (
        await im_session_service.list_runtime_task_notification_subscriptions(
            user_id=user_id,
        )
    )
    return RuntimeIMNotificationSettingsResponse(
        global_settings={
            "enabled": global_settings.enabled,
            "sessionKey": global_settings.session_key,
            "session": (
                _im_notification_session_out(global_session) if global_session else None
            ),
        },
        runtimeTaskSubscriptions=[
            RuntimeTaskIMNotificationSubscription(
                address=_runtime_task_address_from_notification_key(task_key),
                sessionKeys=session_keys,
                sessions=[
                    _im_notification_session_out(session)
                    for session in await _load_user_im_sessions(user_id, session_keys)
                ],
            )
            for task_key, session_keys in subscriptions.items()
        ],
    )


async def update_global_im_notification(
    *,
    db: Session,
    user_id: int,
    request: RuntimeGlobalIMNotificationUpdateRequest,
) -> RuntimeIMNotificationSettingsResponse:
    """Update the user-level IM notification quick switch."""

    await im_session_service.update_global_notification(
        db,
        user_id=user_id,
        enabled=request.enabled,
        session_key=request.session_key,
    )
    return await get_im_notification_settings(db=db, user_id=user_id)


async def subscribe_runtime_task_im_notification(
    *,
    db: Session,
    user_id: int,
    request: RuntimeTaskIMNotificationSubscriptionRequest,
) -> RuntimeTaskIMNotificationSubscriptionResponse:
    """Subscribe a device-local runtime task to private IM notifications."""

    address = _normalized_address(request.address)
    _ensure_owned_device(db, user_id, address.device_id)
    sessions = await im_session_service.load_user_sessions_by_keys(
        db,
        user_id=user_id,
        session_keys=request.session_keys,
    )
    runtime_task = _runtime_task_address_payload(address)
    for session in sessions:
        await im_session_service.subscribe_runtime_task_notification(
            db,
            session=session,
            runtime_task=runtime_task,
        )
    return RuntimeTaskIMNotificationSubscriptionResponse(
        address=address,
        subscribed=True,
        sessionKeys=[session.session_key for session in sessions],
    )


async def unsubscribe_runtime_task_im_notification(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> RuntimeTaskIMNotificationSubscriptionResponse:
    """Remove all private IM notification subscriptions for one runtime task."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    await im_session_service.unsubscribe_runtime_task_notification(
        user_id=user_id,
        runtime_task=_runtime_task_address_payload(normalized_address),
    )
    return RuntimeTaskIMNotificationSubscriptionResponse(
        address=normalized_address,
        subscribed=False,
        sessionKeys=[],
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
            payload=_runtime_task_address_payload(normalized_address),
            timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_archive_response(result, normalized_address)


async def rename_runtime_task(
    *,
    db: Session,
    user_id: int,
    request: RuntimeTaskRenameRequest,
) -> RuntimeTaskArchiveResponse:
    """Rename a LocalTask through the owning local executor."""

    normalized_address = _normalized_address(request.address)
    title = request.title.strip()
    if not title:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="title is required",
        )
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    _touch_workspace_mapping(db, user_id, normalized_address)
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=normalized_address.device_id,
            method="runtime.tasks.rename",
            payload={
                **_runtime_task_address_payload(normalized_address),
                "title": title,
            },
            timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_archive_response(result, normalized_address)


async def cancel_runtime_task(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> RuntimeTaskCancelResponse:
    """Cancel a running LocalTask through the owning local executor."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    _touch_workspace_mapping(db, user_id, normalized_address)
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=normalized_address.device_id,
            method="runtime.tasks.cancel",
            payload=_runtime_task_address_payload(normalized_address),
            timeout_seconds=RUNTIME_CANCEL_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_cancel_response(result, normalized_address)


async def list_archived_conversations(
    *,
    db: Session,
    user_id: int,
    request: ArchivedConversationsListRequest,
) -> ArchivedConversationsListResponse:
    """List archived conversations from online device-local runtime state."""

    devices = await device_service.get_all_devices(db, user_id)
    if request.device_id:
        _ensure_owned_device(db, user_id, request.device_id)
        devices = [
            device
            for device in devices
            if str(device.get("device_id") or "") == request.device_id
        ]

    project_lookup = _archived_project_lookup(db, user_id)
    items: list[ArchivedConversationItem] = []
    for device in devices:
        device_id = str(device.get("device_id") or "")
        if not device_id or _device_status(device) not in {"online", "busy"}:
            continue
        device_source = _archived_device_source(device)
        if request.source != "all" and request.source != device_source:
            continue
        try:
            result = await runtime_rpc_service.call(
                user_id=user_id,
                device_id=device_id,
                method="runtime.archived_conversations.list",
                payload=_archived_list_payload(request),
                timeout_seconds=RUNTIME_LIST_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError:
            continue
        for raw_item in result.get("items", []):
            item = _archived_conversation_item(
                raw_item,
                device_id=device_id,
                device_name=_device_name(device, device_id),
                device_address=_device_address(device, device_id),
                source=device_source,
                project_lookup=project_lookup,
            )
            if item is not None and _include_archived_item(item, request):
                items.append(item)

    items = _sort_archived_items(items, request.sort)
    return ArchivedConversationsListResponse(
        items=items,
        projectGroups=_archived_project_groups(items),
        total=len(items),
    )


async def archive_project_conversations(
    *,
    db: Session,
    user_id: int,
    request: RuntimeArchiveProjectConversationsRequest,
) -> RuntimeArchivedConversationBulkResponse:
    """Archive active conversations under one runtime project."""

    if request.project_id is None and not request.runtime_project_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="projectId or runtimeProjectKey is required",
        )
    if request.project_id is not None:
        _get_active_project(db, user_id, request.project_id, None)

    runtime_work = await list_runtime_work(db=db, user_id=user_id)
    addresses = _active_runtime_addresses(
        runtime_work,
        project_id=request.project_id,
        runtime_project_key=request.runtime_project_key,
    )
    return await _archive_runtime_addresses(
        db=db,
        user_id=user_id,
        addresses=addresses,
    )


async def archive_all_conversations(
    *,
    db: Session,
    user_id: int,
) -> RuntimeArchivedConversationBulkResponse:
    """Archive all active runtime conversations visible on online devices."""

    runtime_work = await list_runtime_work(db=db, user_id=user_id)
    addresses = _active_runtime_addresses(runtime_work)
    return await _archive_runtime_addresses(
        db=db,
        user_id=user_id,
        addresses=addresses,
    )


async def unarchive_conversation(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> RuntimeTaskArchiveResponse:
    """Unarchive one device-local conversation through the owning executor."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    result = await _call_archived_conversation_rpc(
        user_id=user_id,
        address=normalized_address,
        method="runtime.archived_conversations.unarchive",
    )
    if result.get("success") and normalized_address.workspace_path:
        _touch_workspace_mapping(db, user_id, normalized_address)
    return _runtime_archive_response(result, normalized_address)


async def delete_archived_conversation(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
) -> RuntimeTaskArchiveResponse:
    """Delete one archived device-local conversation through the executor."""

    normalized_address = _normalized_address(address)
    _ensure_owned_device(db, user_id, normalized_address.device_id)
    result = await _call_archived_conversation_rpc(
        user_id=user_id,
        address=normalized_address,
        method="runtime.archived_conversations.delete",
    )
    return _runtime_archive_response(result, normalized_address)


async def delete_archived_conversations_bulk(
    *,
    db: Session,
    user_id: int,
    request: RuntimeArchivedConversationBulkRequest,
) -> RuntimeArchivedConversationBulkResponse:
    """Delete archived conversations grouped by owning device RPC."""

    addresses = [_normalized_address(address) for address in request.items]
    for address in addresses:
        _ensure_owned_device(db, user_id, address.device_id)

    grouped: dict[str, list[RuntimeTaskAddress]] = {}
    for address in addresses:
        grouped.setdefault(address.device_id, []).append(address)

    results: list[dict[str, Any]] = []
    deleted_count = 0
    for device_id, device_addresses in grouped.items():
        try:
            result = await runtime_rpc_service.call(
                user_id=user_id,
                device_id=device_id,
                method="runtime.archived_conversations.delete_bulk",
                payload={
                    "items": [
                        _runtime_task_address_payload(address)
                        for address in device_addresses
                    ]
                },
                timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=str(exc),
            ) from exc
        results.append(result)
        deleted_count += int(result.get("deletedCount") or 0)

    return RuntimeArchivedConversationBulkResponse(
        accepted=True,
        requestedCount=len(addresses),
        acceptedCount=len(addresses),
        deletedCount=deleted_count,
        results=results,
    )


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
    if request.local_task_id:
        payload["taskId"] = request.local_task_id
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=target.device_id,
            method="runtime.tasks.create",
            payload=payload,
            timeout_seconds=RUNTIME_CREATE_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_create_response(
        result,
        request.runtime,
        target.device_id,
        target.workspace_path,
    )


async def _register_prepared_runtime_workspace(
    *,
    user_id: int,
    device_id: str,
    workspace_path: str,
    project_name: str,
) -> None:
    payload = {
        "runtime": "codex",
        "workspacePath": workspace_path,
    }
    normalized_name = project_name.strip() if isinstance(project_name, str) else ""
    if normalized_name:
        payload["label"] = normalized_name
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.workspaces.open",
            payload=payload,
            timeout_seconds=RUNTIME_WORKSPACE_OPEN_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    if result.get("success") is False or result.get("accepted") is False:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(result.get("error") or "Runtime workspace registration failed"),
        )


async def open_runtime_workspace(
    *,
    db: Session,
    user_id: int,
    request: RuntimeWorkspaceOpenRequest,
) -> RuntimeWorkspaceOpenResponse:
    """Open/register a runtime workspace without creating a task row or turn."""

    device_id = request.device_id.strip()
    workspace_path = normalize_workspace_path(request.workspace_path)
    _ensure_owned_device(db, user_id, device_id)
    payload = {
        "runtime": request.runtime,
        "workspacePath": workspace_path,
    }
    if request.label:
        payload["label"] = request.label.strip()
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.workspaces.open",
            payload=payload,
            timeout_seconds=RUNTIME_WORKSPACE_OPEN_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_workspace_open_response(
        result=result,
        runtime=request.runtime,
        device_id=device_id,
        workspace_path=workspace_path,
    )


async def rename_runtime_workspace(
    *,
    db: Session,
    user_id: int,
    request: RuntimeWorkspaceRenameRequest,
) -> RuntimeWorkspaceOpenResponse:
    """Rename a runtime workspace project without touching conversations."""

    device_id = request.device_id.strip()
    workspace_path = normalize_workspace_path(request.workspace_path)
    name = request.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="name is required",
        )
    _ensure_owned_device(db, user_id, device_id)
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.workspaces.rename",
            payload={
                "runtime": request.runtime,
                "workspacePath": workspace_path,
                "label": name,
            },
            timeout_seconds=RUNTIME_WORKSPACE_OPEN_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_workspace_open_response(
        result=result,
        runtime=request.runtime,
        device_id=device_id,
        workspace_path=workspace_path,
    )


async def remove_runtime_workspace(
    *,
    db: Session,
    user_id: int,
    request: RuntimeWorkspaceRemoveRequest,
) -> RuntimeWorkspaceOpenResponse:
    """Remove a runtime workspace project without deleting conversations."""

    device_id = request.device_id.strip()
    workspace_path = normalize_workspace_path(request.workspace_path)
    _ensure_owned_device(db, user_id, device_id)
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.workspaces.remove",
            payload={
                "runtime": request.runtime,
                "workspacePath": workspace_path,
            },
            timeout_seconds=RUNTIME_WORKSPACE_OPEN_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return _runtime_workspace_open_response(
        result=result,
        runtime=request.runtime,
        device_id=device_id,
        workspace_path=workspace_path,
    )


async def search_runtime_workspace(
    *,
    db: Session,
    user_id: int,
    request: RuntimeWorkspaceSearchRequest,
) -> RuntimeWorkspaceSearchResponse:
    """Search one workspace through its owning online local executor."""

    device_id = request.device_id.strip()
    _ensure_owned_device(db, user_id, device_id)
    payload: dict[str, Any] = {
        "root": normalize_workspace_path(request.root),
        "query": request.query.strip(),
    }
    if request.cancellation_token:
        payload["cancellationToken"] = request.cancellation_token
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.workspace.search",
            payload=payload,
            timeout_seconds=RUNTIME_SEARCH_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return RuntimeWorkspaceSearchResponse.model_validate(result)


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
    source = await _resolve_runtime_task_source_address(
        user_id=user_id,
        source=source,
    )
    _touch_workspace_mapping(db, user_id, source)

    transfer_id = str(uuid4())
    workspace_transfer = await _runtime_fork_workspace_transfer(
        db=db,
        user_id=user_id,
        source=source,
        target_device_id=target_device_id,
        target_workspace_path=target_workspace_path,
        transfer_id=transfer_id,
    )
    import_workspace_path = (
        workspace_transfer.target_workspace_path
        if workspace_transfer
        else target_workspace_path
    )
    prepare_payload = {
        **source.model_dump(by_alias=True),
        "transferId": transfer_id,
    }
    source_direct_hosts = await _runtime_transfer_direct_hosts(
        db=db,
        user_id=user_id,
        device_id=source.device_id,
        peer_device_id=target_device_id,
    )
    prepare_payload["directHosts"] = source_direct_hosts
    if workspace_transfer:
        prepare_payload["workspaceTransfer"] = workspace_transfer.mode

    try:
        package_result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=source.device_id,
            method="runtime.tasks.prepare_fork_transfer",
            payload=prepare_payload,
            timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
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
                "workspacePath": import_workspace_path,
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
                    "directHosts": await _runtime_transfer_direct_hosts(
                        db=db,
                        user_id=user_id,
                        device_id=target_device_id,
                        peer_device_id=source.device_id,
                    ),
                },
                timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError as exc:
            logger.info(
                "Runtime fork prepare receiver failed: user_id=%s target_device=%s "
                "transfer_id=%s error=%s",
                user_id,
                target_device_id,
                push_transfer_id,
                exc,
            )
            receiver_result = {"success": False, "error": str(exc)}

        if receiver_result.get("success") is not False:
            upload_urls = receiver_result.get("uploadUrls")
            usable_upload_urls = [
                url for url in upload_urls or [] if isinstance(url, str) and url.strip()
            ]
            if usable_upload_urls:
                try:
                    push_result = await runtime_rpc_service.call(
                        user_id=user_id,
                        device_id=source.device_id,
                        method="runtime.tasks.push_fork_transfer",
                        payload={
                            "transferId": transfer_id,
                            "uploadUrls": usable_upload_urls,
                            "uploadToken": push_token,
                        },
                        timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
                    )
                except RuntimeRpcError as exc:
                    logger.info(
                        "Runtime fork direct push failed: user_id=%s source_device=%s "
                        "target_device=%s transfer_id=%s upload_urls=%s error=%s",
                        user_id,
                        source.device_id,
                        target_device_id,
                        transfer_id,
                        usable_upload_urls,
                        exc,
                    )
                    push_result = {"success": False, "error": str(exc)}
            else:
                logger.info(
                    "Runtime fork direct receiver returned no upload URLs: user_id=%s "
                    "source_device=%s target_device=%s transfer_id=%s",
                    user_id,
                    source.device_id,
                    target_device_id,
                    push_transfer_id,
                )
                push_result = {"success": False, "error": "No direct upload URLs"}
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
                            "workspacePath": import_workspace_path,
                            "forkPackage": fork_package,
                        },
                        timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
                    )
                except RuntimeRpcError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
                    ) from exc

    if import_result.get("success") is False:
        object_key = f"runtime-task-transfers/{user_id}/{transfer_id}.tar.gz"
        try:
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
        except Exception as exc:
            logger.warning(
                "Runtime fork object storage fallback unavailable: user_id=%s "
                "source_device=%s target_device=%s transfer_id=%s error=%s",
                user_id,
                source.device_id,
                target_device_id,
                transfer_id,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    "Runtime fork direct transfer failed and object storage fallback "
                    "is not configured"
                ),
            ) from exc
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
            ) from exc
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
                    "workspacePath": import_workspace_path,
                    "forkPackage": fork_package,
                },
                timeout_seconds=RUNTIME_FORK_TIMEOUT_SECONDS,
            )
        except RuntimeRpcError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
            ) from exc

    response = _runtime_fork_response(
        result=import_result,
        source=source,
        target_device_id=target_device_id,
        target_workspace_path=import_workspace_path,
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


async def _prepare_plain_workspace_path(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
    action: str,
) -> str:
    status_payload = await _read_project_folder_status(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path=workspace_path,
    )
    if action == "create":
        if status_payload.get("exists"):
            _ensure_selectable_directory(status_payload)
            if status_payload.get("isEmpty"):
                return "created"
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Project folder already exists",
            )
        mkdir_result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="mkdir_p",
            args=[workspace_path],
            timeout_seconds=30,
        )
        _raise_for_failed_device_command(
            mkdir_result, "Failed to create project folder"
        )
        return "created"

    _ensure_selectable_directory(status_payload)
    return "selected"


async def _prepare_git_workspace_path(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
    git_url: str,
    branch: Optional[str],
    git_domain: Optional[str],
    action: str,
) -> str:
    status_payload = await _read_project_folder_status(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path=workspace_path,
    )
    if not status_payload.get("exists") or status_payload.get("isEmpty"):
        await _clone_git_workspace_path(
            db=db,
            user_id=user_id,
            device_id=device_id,
            workspace_path=workspace_path,
            git_url=git_url,
            branch=branch,
            git_domain=git_domain,
        )
        return "cloned"

    _ensure_selectable_directory(status_payload)
    if not status_payload.get("isGitRepo"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Project folder has existing content and is not a Git repository",
        )
    remote_url = str(status_payload.get("remoteUrl") or "")
    if not _git_urls_match(remote_url, git_url):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Project folder is linked to another repository",
        )
    await _reuse_git_workspace_path(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path=workspace_path,
        branch=branch,
        git_domain=git_domain,
    )
    return "reused_git"


async def _read_project_folder_status(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
) -> dict[str, Any]:
    result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="project_folder_status",
        args=[workspace_path],
        timeout_seconds=30,
    )
    _raise_for_failed_device_command(result, "Failed to inspect project folder")
    stdout = result.get("stdout")
    if isinstance(stdout, dict):
        return stdout
    if isinstance(stdout, str):
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Invalid project folder status response: {exc}",
            ) from exc
        if isinstance(parsed, dict):
            return parsed
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Invalid project folder status response",
    )


def _ensure_selectable_directory(status_payload: dict[str, Any]) -> None:
    if not status_payload.get("exists"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project folder does not exist",
        )
    if not status_payload.get("isDirectory"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Project folder path is not a directory",
        )


async def _clone_git_workspace_path(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
    git_url: str,
    branch: Optional[str],
    git_domain: Optional[str],
) -> None:
    parent_path = posixpath.dirname(workspace_path)
    if parent_path and parent_path != ".":
        mkdir_result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="mkdir_p",
            args=[parent_path],
            timeout_seconds=30,
        )
        _raise_for_failed_device_command(mkdir_result, "Failed to create parent folder")

    clone_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="git_clone",
        args=_build_git_clone_args(git_url, branch, workspace_path),
        timeout_seconds=DEVICE_WORKSPACE_PREPARE_TIMEOUT_SECONDS,
        max_output_bytes=5 * 1024 * 1024,
    )
    _raise_for_failed_device_command(clone_result, "Failed to clone Git repository")
    await _configure_git_workspace_identity(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path=workspace_path,
        git_domain=git_domain,
    )


async def _reuse_git_workspace_path(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
    branch: Optional[str],
    git_domain: Optional[str],
) -> None:
    fetch_result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=device_id,
        command_key="git_fetch",
        path=workspace_path,
        timeout_seconds=DEVICE_WORKSPACE_PREPARE_TIMEOUT_SECONDS,
        max_output_bytes=5 * 1024 * 1024,
    )
    _raise_for_failed_device_command(fetch_result, "Failed to fetch Git repository")
    if branch and branch.strip():
        checkout_result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="git_checkout",
            path=workspace_path,
            args=[branch.strip()],
            timeout_seconds=30,
        )
        _raise_for_failed_device_command(checkout_result, "Failed to checkout branch")
    await _configure_git_workspace_identity(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path=workspace_path,
        git_domain=git_domain,
    )


async def _configure_git_workspace_identity(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
    git_domain: Optional[str],
) -> None:
    git_user_name, git_user_email = _resolve_user_git_identity(
        db,
        user_id=user_id,
        git_domain=git_domain,
    )
    if not git_user_name or not git_user_email:
        return
    for key, value in (("user.name", git_user_name), ("user.email", git_user_email)):
        config_result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="git_config",
            path=workspace_path,
            args=[key, value],
            timeout_seconds=30,
        )
        _raise_for_failed_device_command(
            config_result, f"Failed to configure Git {key}"
        )


def _resolve_user_git_identity(
    db: Session,
    *,
    user_id: int,
    git_domain: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None, None

    git_info_list = user.git_info or []
    if not isinstance(git_info_list, list):
        git_info_list = [git_info_list] if git_info_list else []
    if not git_info_list:
        return None, None

    matched_git_info = None
    if git_domain:
        for git_info in git_info_list:
            if str(git_info.get("git_domain") or "") == git_domain:
                matched_git_info = git_info
                break
    if not matched_git_info:
        matched_git_info = git_info_list[0]

    git_login = matched_git_info.get("git_login")
    git_email = matched_git_info.get("git_email")
    git_id = matched_git_info.get("git_id")
    if not git_email and git_id and git_login:
        git_email = f"{git_id}+{git_login}@users.noreply.github.com"
    return git_login, git_email


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


def _git_urls_match(left: str, right: str) -> bool:
    return _normalize_git_url(left) == _normalize_git_url(right)


def _normalize_git_url(url: str) -> str:
    value = url.strip()
    if value.startswith("git@") and ":" in value:
        host, path = value[4:].split(":", 1)
        value = f"https://{host}/{path}"
    parsed = urlparse(value)
    if parsed.scheme and parsed.netloc:
        value = f"{parsed.netloc}{parsed.path}"
    return value.lower().removesuffix(".git").rstrip("/")


def _raise_for_failed_device_command(result: dict[str, Any], message: str) -> None:
    if bool(result.get("success")) and result.get("exit_code") == 0:
        return
    detail = str(result.get("stderr") or result.get("error") or message)
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _runtime_send_response(
    result: dict[str, Any],
    local_task_id: str,
) -> RuntimeSendResponse:
    if result.get("success") is False:
        return RuntimeSendResponse(
            accepted=False,
            taskId=str(result.get("taskId") or local_task_id),
            error=str(result.get("error") or "Runtime send failed"),
        )
    return RuntimeSendResponse(
        accepted=bool(result.get("accepted", True)),
        taskId=str(result.get("taskId") or local_task_id),
        error=result.get("error"),
    )


def _runtime_guidance_response(
    result: dict[str, Any],
    local_task_id: str,
) -> RuntimeGuidanceResponse:
    success = result.get("success")
    accepted = bool(result.get("accepted", success is not False))
    return RuntimeGuidanceResponse(
        accepted=accepted,
        success=success is not False,
        taskId=str(result.get("taskId") or local_task_id),
        guidanceId=result.get("guidanceId") or result.get("guidance_id"),
        turnId=result.get("turnId") or result.get("turn_id"),
        error=result.get("error"),
        code=result.get("code"),
    )


def _runtime_archive_response(
    result: dict[str, Any],
    address: RuntimeTaskAddress,
) -> RuntimeTaskArchiveResponse:
    if result.get("success") is False:
        return RuntimeTaskArchiveResponse(
            accepted=False,
            taskId=str(result.get("taskId") or address.local_task_id),
            workspacePath=result.get("workspacePath") or address.workspace_path,
            error=str(result.get("error") or "Runtime archive failed"),
        )
    return RuntimeTaskArchiveResponse(
        accepted=bool(result.get("accepted", True)),
        taskId=str(result.get("taskId") or address.local_task_id),
        workspacePath=result.get("workspacePath") or address.workspace_path,
        error=result.get("error"),
    )


def _runtime_cancel_response(
    result: dict[str, Any],
    address: RuntimeTaskAddress,
) -> RuntimeTaskCancelResponse:
    if result.get("success") is False:
        return RuntimeTaskCancelResponse(
            accepted=False,
            taskId=str(result.get("taskId") or address.local_task_id),
            workspacePath=result.get("workspacePath") or address.workspace_path,
            error=str(result.get("error") or "Runtime cancel failed"),
        )
    return RuntimeTaskCancelResponse(
        accepted=bool(result.get("accepted", True)),
        taskId=str(result.get("taskId") or address.local_task_id),
        workspacePath=result.get("workspacePath") or address.workspace_path,
        error=result.get("error"),
    )


def _im_notification_session_out(
    session: IMPrivateSession,
) -> RuntimeIMNotificationSession:
    return RuntimeIMNotificationSession(
        sessionKey=session.session_key,
        channelType=session.channel_type,
        channelLabel=im_session_service.get_channel_label(session.channel_type),
        channelId=session.channel_id,
        conversationId=session.conversation_id,
        senderId=session.sender_id,
        displayName=session.display_name,
    )


async def _load_user_im_session(
    user_id: int,
    session_key: str | None,
) -> IMPrivateSession | None:
    if not session_key:
        return None
    session = await im_session_service.get_session(session_key)
    if session is None or session.user_id != user_id:
        return None
    return session


async def _load_user_im_sessions(
    user_id: int,
    session_keys: list[str],
) -> list[IMPrivateSession]:
    sessions: list[IMPrivateSession] = []
    for session_key in session_keys:
        session = await _load_user_im_session(user_id, session_key)
        if session is not None:
            sessions.append(session)
    return sessions


def _runtime_task_address_from_notification_key(task_key: str) -> RuntimeTaskAddress:
    try:
        device_id, local_task_id = task_key.split("\0", 1)
    except ValueError:
        device_id = ""
        local_task_id = task_key
    return RuntimeTaskAddress(deviceId=device_id, localTaskId=local_task_id)


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
            taskId=str(result.get("taskId") or ""),
            workspacePath=str(result.get("workspacePath") or workspace_path),
            runtime=result.get("runtime") or runtime,
            error=str(result.get("error") or "Runtime task creation failed"),
        )
    return RuntimeTaskCreateResponse(
        accepted=bool(result.get("accepted", True)),
        deviceId=str(result.get("deviceId") or device_id),
        taskId=str(result.get("taskId") or ""),
        workspacePath=str(result.get("workspacePath") or workspace_path),
        runtime=result.get("runtime") or runtime,
        error=result.get("error"),
    )


def _runtime_workspace_open_response(
    *,
    result: dict[str, Any],
    runtime: str,
    device_id: str,
    workspace_path: str,
) -> RuntimeWorkspaceOpenResponse:
    if result.get("success") is False:
        return RuntimeWorkspaceOpenResponse(
            accepted=False,
            deviceId=str(result.get("deviceId") or device_id),
            workspacePath=str(result.get("workspacePath") or workspace_path),
            runtime=result.get("runtime") or runtime,
            threadId=result.get("threadId"),
            error=str(result.get("error") or "Runtime workspace open failed"),
        )
    return RuntimeWorkspaceOpenResponse(
        accepted=bool(result.get("accepted", True)),
        deviceId=str(result.get("deviceId") or device_id),
        workspacePath=str(result.get("workspacePath") or workspace_path),
        runtime=result.get("runtime") or runtime,
        threadId=result.get("threadId"),
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
        taskId=str(result.get("taskId") or ""),
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


async def _resolve_runtime_task_source_address(
    *,
    user_id: int,
    source: RuntimeTaskAddress,
) -> RuntimeTaskAddress:
    if source.workspace_path:
        return source
    workspace_path = await _runtime_task_workspace_path(
        user_id=user_id,
        address=source,
    )
    if not workspace_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Runtime task workspacePath not found",
        )
    return RuntimeTaskAddress(
        deviceId=source.device_id,
        workspacePath=workspace_path,
        localTaskId=source.local_task_id,
    )


async def _runtime_task_workspace_path(
    *,
    user_id: int,
    address: RuntimeTaskAddress,
) -> Optional[str]:
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=address.device_id,
            method="runtime.tasks.list",
            payload={},
            timeout_seconds=RUNTIME_LIST_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to resolve runtime task workspacePath: {exc}",
        ) from exc
    _raise_runtime_rpc_failure(result)
    return _workspace_path_for_runtime_task(result, address.local_task_id)


def _workspace_path_for_runtime_task(
    result: dict[str, Any],
    local_task_id: str,
) -> Optional[str]:
    expected_task_id = str(local_task_id).strip()
    if not expected_task_id:
        return None
    for workspace in _iter_runtime_workspaces(result):
        workspace_path = normalize_workspace_path(workspace["workspacePath"])
        for task in workspace["tasks"]:
            if not isinstance(task, dict):
                continue
            task_id = str(task.get("taskId") or "")
            if task_id.strip() != expected_task_id:
                continue
            task_path = task.get("workspacePath") or task.get("workspace_path")
            if isinstance(task_path, str) and task_path.strip():
                return normalize_workspace_path(task_path)
            return workspace_path
    return None


def _raise_runtime_rpc_failure(result: dict[str, Any]) -> None:
    if result.get("success") is not False:
        return
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=str(result.get("error") or "Runtime RPC failed"),
    )


async def _runtime_fork_workspace_transfer(
    *,
    db: Session,
    user_id: int,
    source: RuntimeTaskAddress,
    target_device_id: str,
    target_workspace_path: str,
    transfer_id: str,
) -> Optional[RuntimeForkWorkspaceTransfer]:
    mappings = list_device_workspace_kinds(db=db, user_id=user_id)
    target_project_id = _project_id_for_runtime_workspace(
        mappings=mappings,
        device_id=target_device_id,
        workspace_path=target_workspace_path,
    )
    if target_project_id is None:
        return None
    source_commit = await _runtime_git_workspace_transfer_source_commit(
        db=db,
        user_id=user_id,
        source=source,
        target_device_id=target_device_id,
        target_workspace_path=target_workspace_path,
    )
    if not source_commit:
        return None
    target_worktree_path = _runtime_fork_git_worktree_path(
        target_workspace_path=target_workspace_path,
        transfer_id=transfer_id,
    )
    if target_worktree_path != target_workspace_path:
        await _prepare_runtime_fork_git_worktree(
            db=db,
            user_id=user_id,
            target_device_id=target_device_id,
            target_workspace_path=target_workspace_path,
            target_worktree_path=target_worktree_path,
            source_commit=source_commit,
        )
    return RuntimeForkWorkspaceTransfer(
        mode="git_workspace",
        target_workspace_path=target_worktree_path,
        source_commit=source_commit,
    )


async def _runtime_transfer_direct_hosts(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    peer_device_id: str,
) -> list[str]:
    hosts: list[str] = []
    online_info = await device_service.get_device_online_info(user_id, device_id)
    if isinstance(online_info, dict):
        _append_runtime_transfer_host(hosts, online_info.get("runtime_transfer_host"))
        _append_runtime_transfer_host(hosts, online_info.get("client_ip"))

    if device_id != peer_device_id:
        hosts = [host for host in hosts if not _is_loopback_transfer_host(host)]
    return list(dict.fromkeys(hosts))


def _append_runtime_transfer_host(hosts: list[str], value: Any) -> None:
    if not isinstance(value, str):
        return
    host = value.strip()
    if not host:
        return
    hosts.append(host)


def _is_loopback_transfer_host(host: str) -> bool:
    normalized = host.strip().lower()
    return (
        normalized == "localhost"
        or normalized == "::1"
        or normalized.startswith("127.")
    )


async def _runtime_git_workspace_transfer_source_commit(
    *,
    db: Session,
    user_id: int,
    source: RuntimeTaskAddress,
    target_device_id: str,
    target_workspace_path: str,
) -> Optional[str]:
    if not source.workspace_path:
        return None
    source_status = await _runtime_git_status(
        db=db,
        user_id=user_id,
        device_id=source.device_id,
        workspace_path=source.workspace_path,
    )
    target_status = await _runtime_git_status(
        db=db,
        user_id=user_id,
        device_id=target_device_id,
        workspace_path=target_workspace_path,
    )
    if not source_status or not target_status:
        return None
    source_origin = _normalize_git_remote_url(source_status.get("remoteUrl"))
    target_origin = _normalize_git_remote_url(target_status.get("remoteUrl"))
    if not source_origin or source_origin != target_origin:
        return None
    source_commit = _string_value(source_status.get("headCommit"))
    if not source_commit:
        return None
    available = await _runtime_git_commit_available(
        db=db,
        user_id=user_id,
        device_id=target_device_id,
        workspace_path=target_workspace_path,
        commit=source_commit,
    )
    return source_commit if available else None


async def _prepare_runtime_fork_git_worktree(
    *,
    db: Session,
    user_id: int,
    target_device_id: str,
    target_workspace_path: str,
    target_worktree_path: str,
    source_commit: str,
) -> None:
    result = await execute_configured_device_command(
        db=db,
        user_id=user_id,
        device_id=target_device_id,
        command_key="git_worktree_add",
        args=[target_workspace_path, target_worktree_path, source_commit],
        timeout_seconds=DEVICE_WORKSPACE_PREPARE_TIMEOUT_SECONDS,
        max_output_bytes=5 * 1024 * 1024,
    )
    _raise_for_failed_device_command(result, "Failed to prepare Git worktree")


def _runtime_fork_git_worktree_path(
    *,
    target_workspace_path: str,
    transfer_id: str,
) -> str:
    normalized_target = normalize_workspace_path(target_workspace_path)
    if _parse_runtime_worktree_path(normalized_target):
        return normalized_target

    worktree_id = _runtime_fork_worktree_id(transfer_id)
    project_dir_name = _path_basename(normalized_target)
    relative_worktree_path = posixpath.join(
        WORKTREE_ROOT_DIR,
        worktree_id,
        project_dir_name,
    )

    parts = [part for part in normalized_target.split("/") if part]
    if "projects" in parts:
        project_root_index = parts.index("projects")
        prefix_parts = parts[:project_root_index]
        if normalized_target.startswith("/"):
            prefix = "/" + "/".join(prefix_parts) if prefix_parts else "/"
            return _join_device_path(prefix, relative_worktree_path)
        if not prefix_parts:
            return relative_worktree_path
        return _join_device_path("/".join(prefix_parts), relative_worktree_path)

    parent = posixpath.dirname(normalized_target)
    return _join_device_path(parent, relative_worktree_path)


def _runtime_fork_worktree_id(transfer_id: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", transfer_id.strip()).strip("-")
    if normalized and RUNTIME_WORKTREE_ID_PATTERN.fullmatch(normalized):
        return normalized
    return uuid4().hex


def _join_device_path(root: str, relative_path: str) -> str:
    return f"{root.rstrip('/')}/{relative_path.strip('/')}"


async def _runtime_git_status(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
) -> Optional[dict[str, Any]]:
    try:
        status_payload = await _read_project_folder_status(
            db=db,
            user_id=user_id,
            device_id=device_id,
            workspace_path=workspace_path,
        )
    except Exception:
        return None
    if not status_payload.get("isGitRepo"):
        return None
    return status_payload


async def _runtime_git_commit_available(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path: str,
    commit: str,
) -> bool:
    try:
        result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="git_commit_available",
            args=[workspace_path, commit],
            timeout_seconds=30,
        )
    except Exception:
        return False
    return result.get("success") is not False and int(result.get("exit_code", 1)) == 0


def _normalize_git_remote_url(value: Any) -> Optional[str]:
    text = _string_value(value)
    if not text:
        return None
    if text.startswith("git@") and ":" in text:
        host_part, path_part = text.split(":", maxsplit=1)
        host = host_part.removeprefix("git@").lower()
        path = path_part.strip().strip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return f"{host}/{path}" if host and path else None

    parsed = urlparse(text)
    if parsed.scheme and parsed.netloc:
        host = parsed.hostname or parsed.netloc.rsplit("@", maxsplit=1)[-1]
        path = parsed.path.strip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return f"{host.lower()}/{path}" if host and path else None

    normalized = text.strip().strip("/")
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    return normalized or None


def _string_value(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _device_workspace_mapping_for_path(
    *,
    mappings: list[DeviceWorkspaceResponse],
    device_id: str,
    workspace_path: str,
) -> Optional[DeviceWorkspaceResponse]:
    try:
        normalized_workspace_path = normalize_workspace_path(workspace_path)
    except ValueError:
        return None
    for mapping in mappings:
        if (
            mapping.device_id == device_id
            and mapping.workspace_path == normalized_workspace_path
        ):
            return mapping
    return None


def _project_id_for_runtime_workspace(
    *,
    mappings: list[DeviceWorkspaceResponse],
    device_id: str,
    workspace_path: Optional[str],
) -> Optional[int]:
    if not workspace_path:
        return None
    try:
        normalized_workspace_path = normalize_workspace_path(workspace_path)
    except ValueError:
        return None
    for mapping in mappings:
        if (
            mapping.device_id == device_id
            and mapping.workspace_path == normalized_workspace_path
        ):
            return mapping.project_id

    worktree = _parse_runtime_worktree_path(normalized_workspace_path)
    if worktree is None:
        return None
    for mapping in mappings:
        if mapping.device_id != device_id:
            continue
        if (
            _path_basename(mapping.workspace_path).lower()
            == worktree.project_dir_name.lower()
        ):
            return mapping.project_id
    return None


async def _list_online_runtime_workspaces(
    *,
    user_id: int,
    devices: list[dict[str, Any]],
) -> dict[tuple[str, str], RuntimeWorkspaceListing]:
    started_at = time.perf_counter()
    online_devices = [
        device
        for device in devices
        if str(device.get("device_id") or "")
        and _device_status(device) in {"online", "busy"}
    ]
    results = await asyncio.gather(
        *[
            _list_runtime_workspaces_for_device(user_id=user_id, device=device)
            for device in online_devices
        ],
        return_exceptions=True,
    )

    grouped: dict[tuple[str, str], RuntimeWorkspaceListing] = {}
    for result in results:
        if isinstance(result, Exception):
            logger.warning(
                "[RuntimeWork] Failed to list runtime workspaces from device: user_id=%s error_type=%s",
                user_id,
                result.__class__.__name__,
            )
            continue
        grouped.update(result)

    logger.info(
        "[RuntimeWork] Listed runtime workspaces: user_id=%s online_devices=%s workspace_count=%s task_count=%s elapsed_ms=%s",
        user_id,
        len(online_devices),
        len(grouped),
        sum(len(listing.local_tasks) for listing in grouped.values()),
        int((time.perf_counter() - started_at) * 1000),
    )
    return grouped


async def _list_runtime_workspaces_for_device(
    *,
    user_id: int,
    device: dict[str, Any],
) -> dict[tuple[str, str], RuntimeWorkspaceListing]:
    started_at = time.perf_counter()
    device_id = str(device.get("device_id") or "")
    if not device_id:
        return {}

    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.tasks.list",
            payload={},
            timeout_seconds=RUNTIME_LIST_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        logger.warning(
            "[RuntimeWork] Runtime workspace list failed: user_id=%s device_id=%s elapsed_ms=%s error=%s",
            user_id,
            device_id,
            int((time.perf_counter() - started_at) * 1000),
            str(exc),
        )
        return {}

    grouped: dict[tuple[str, str], RuntimeWorkspaceListing] = {}
    for order_index, workspace in enumerate(_iter_runtime_workspaces(result)):
        workspace_path = normalize_workspace_path(workspace["workspacePath"])
        tasks = [
            LocalTaskSummary.model_validate(
                {
                    **task,
                    **_runtime_task_kind_fields(
                        task,
                        normalize_workspace_path(
                            str(task.get("workspacePath") or workspace_path)
                        ),
                    ),
                    "workspacePath": normalize_workspace_path(
                        str(task.get("workspacePath") or workspace_path)
                    ),
                }
            )
            for task in workspace["tasks"]
            if isinstance(task, dict)
        ]
        grouped[(device_id, workspace_path)] = RuntimeWorkspaceListing(
            local_tasks=tasks,
            order_index=order_index,
            label=_runtime_workspace_label(workspace),
            workspace_source=_runtime_workspace_source(workspace),
            remote_host_id=_runtime_workspace_remote_host_id(workspace),
        )

    logger.info(
        "[RuntimeWork] Runtime workspace list completed: user_id=%s device_id=%s workspace_count=%s task_count=%s elapsed_ms=%s",
        user_id,
        device_id,
        len(grouped),
        sum(len(listing.local_tasks) for listing in grouped.values()),
        int((time.perf_counter() - started_at) * 1000),
    )
    return grouped


def _archived_list_payload(
    request: ArchivedConversationsListRequest,
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if request.workspace_path:
        payload["workspacePath"] = normalize_workspace_path(request.workspace_path)
    if request.search:
        payload["search"] = request.search.strip()
    return payload


def _archived_project_lookup(
    db: Session,
    user_id: int,
) -> dict[tuple[str, str], dict[str, Any]]:
    mappings = list_device_workspace_kinds(db=db, user_id=user_id)
    project_ids = {mapping.project_id for mapping in mappings}
    projects = (
        db.query(Project)
        .filter(
            Project.user_id == user_id,
            Project.id.in_(project_ids),
            Project.is_active == True,
        )
        .all()
        if project_ids
        else []
    )
    projects_by_id = {project.id: project for project in projects}
    lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for mapping in mappings:
        workspace_path = normalize_workspace_path(mapping.workspace_path)
        project = projects_by_id.get(mapping.project_id)
        lookup[(mapping.device_id, workspace_path)] = {
            "projectId": mapping.project_id,
            "projectKey": f"project:{mapping.project_id}",
            "projectName": project.name if project else mapping.label,
        }
    return lookup


def _archived_conversation_item(
    raw_item: Any,
    *,
    device_id: str,
    device_name: str,
    device_address: str,
    source: str,
    project_lookup: dict[tuple[str, str], dict[str, Any]],
) -> Optional[ArchivedConversationItem]:
    if not isinstance(raw_item, dict):
        return None
    local_task_id = raw_item.get("localTaskId") or raw_item.get("id")
    workspace_path = raw_item.get("workspacePath")
    if not isinstance(local_task_id, str) or not local_task_id.strip():
        return None
    if not isinstance(workspace_path, str) or not workspace_path.strip():
        return None

    normalized_workspace = normalize_workspace_path(workspace_path)
    project = project_lookup.get((device_id, normalized_workspace)) or {}
    project_key = str(
        project.get("projectKey")
        or _runtime_workspace_key(device_id, normalized_workspace)
    )
    project_name = str(
        project.get("projectName") or _path_basename(normalized_workspace)
    )
    runtime = raw_item.get("runtime")
    return ArchivedConversationItem(
        id=f"{device_id}:{local_task_id.strip()}",
        localTaskId=local_task_id.strip(),
        title=str(raw_item.get("title") or local_task_id).strip(),
        projectId=project.get("projectId"),
        projectKey=project_key,
        projectName=project_name,
        workspacePath=normalized_workspace,
        workspaceKind=raw_item.get("workspaceKind") or "workspace",
        deviceId=device_id,
        deviceName=device_name,
        deviceAddress=device_address,
        source=source if source == "local" else "cloud",
        runtime=runtime if runtime in {"codex", "claude_code"} else None,
        createdAt=raw_item.get("createdAt"),
        updatedAt=raw_item.get("updatedAt"),
    )


def _include_archived_item(
    item: ArchivedConversationItem,
    request: ArchivedConversationsListRequest,
) -> bool:
    if request.source != "all" and item.source != request.source:
        return False
    if request.project_id is not None and item.project_id != request.project_id:
        return False
    if request.runtime_project_key and item.project_key != request.runtime_project_key:
        return False
    if (
        request.search
        and request.search.strip().lower()
        not in " ".join(
            [
                item.title,
                item.project_name or "",
                item.workspace_path,
                item.local_task_id,
            ]
        ).lower()
    ):
        return False
    return True


def _sort_archived_items(
    items: list[ArchivedConversationItem],
    sort_key: str,
) -> list[ArchivedConversationItem]:
    if sort_key == "alphabetical":
        return sorted(items, key=lambda item: item.title.lower())
    if sort_key == "created":
        return sorted(
            items,
            key=lambda item: _timestamp_from_iso(item.created_at),
            reverse=True,
        )
    return sorted(
        items,
        key=lambda item: _timestamp_from_iso(item.updated_at or item.created_at),
        reverse=True,
    )


def _archived_project_groups(
    items: list[ArchivedConversationItem],
) -> list[ArchivedConversationProjectGroup]:
    grouped: dict[tuple[Optional[int], Optional[str], str], int] = {}
    for item in items:
        key = (
            item.project_id,
            item.project_key,
            item.project_name or _path_basename(item.workspace_path),
        )
        grouped[key] = grouped.get(key, 0) + 1
    return [
        ArchivedConversationProjectGroup(
            projectId=project_id,
            projectKey=project_key,
            projectName=project_name,
            count=count,
        )
        for (project_id, project_key, project_name), count in sorted(
            grouped.items(),
            key=lambda item: item[0][2].lower(),
        )
    ]


async def _archive_runtime_addresses(
    *,
    db: Session,
    user_id: int,
    addresses: list[RuntimeTaskAddress],
) -> RuntimeArchivedConversationBulkResponse:
    results: list[dict[str, Any]] = []
    accepted_count = 0
    for address in addresses:
        response = await archive_runtime_task(
            db=db,
            user_id=user_id,
            address=address,
        )
        payload = response.model_dump(by_alias=True, exclude_none=True)
        if response.accepted:
            accepted_count += 1
        results.append(payload)
    return RuntimeArchivedConversationBulkResponse(
        accepted=True,
        requestedCount=len(addresses),
        acceptedCount=accepted_count,
        results=results,
    )


def _active_runtime_addresses(
    runtime_work: RuntimeWorkListResponse,
    *,
    project_id: Optional[int] = None,
    runtime_project_key: Optional[str] = None,
) -> list[RuntimeTaskAddress]:
    addresses: list[RuntimeTaskAddress] = []
    include_chats = project_id is None and runtime_project_key is None
    for project_work in runtime_work.projects:
        if not _runtime_project_matches(
            project_work,
            project_id=project_id,
            runtime_project_key=runtime_project_key,
        ):
            continue
        addresses.extend(_workspace_task_addresses(project_work.device_workspaces))
    if include_chats:
        addresses.extend(_workspace_task_addresses(runtime_work.chats))
    return addresses


def _runtime_project_matches(
    project_work: RuntimeProjectWork,
    *,
    project_id: Optional[int],
    runtime_project_key: Optional[str],
) -> bool:
    if project_id is not None and project_work.project.id != project_id:
        return False
    if runtime_project_key and project_work.project.key != runtime_project_key:
        return False
    return True


def _workspace_task_addresses(
    workspaces: list[RuntimeDeviceWorkspace],
) -> list[RuntimeTaskAddress]:
    addresses: list[RuntimeTaskAddress] = []
    for workspace in workspaces:
        for task in workspace.local_tasks:
            if task.status == "archived":
                continue
            addresses.append(
                RuntimeTaskAddress(
                    deviceId=workspace.device_id,
                    workspacePath=workspace.workspace_path,
                    localTaskId=task.local_task_id,
                )
            )
    return addresses


async def _call_archived_conversation_rpc(
    *,
    user_id: int,
    address: RuntimeTaskAddress,
    method: str,
) -> dict[str, Any]:
    try:
        return await runtime_rpc_service.call(
            user_id=user_id,
            device_id=address.device_id,
            method=method,
            payload=_runtime_task_address_payload(address),
            timeout_seconds=RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc


def _runtime_device_order(devices: list[dict[str, Any]]) -> dict[str, int]:
    ordered_devices = sorted(
        enumerate(devices),
        key=lambda item: (_runtime_device_type_rank(item[1]), item[0]),
    )
    return {
        str(device.get("device_id") or ""): index
        for index, (_original_index, device) in enumerate(ordered_devices)
        if str(device.get("device_id") or "")
    }


def _runtime_device_type_rank(device: dict[str, Any]) -> int:
    return 0 if _device_type(device) == "local" else 1


def _runtime_workspace_order_key(
    item: tuple[tuple[str, str], RuntimeWorkspaceListing],
    device_order: dict[str, int],
) -> tuple[int, int, str]:
    (device_id, workspace_path), listing = item
    return (
        device_order.get(device_id, len(device_order)),
        listing.order_index,
        workspace_path.lower(),
    )


def _parse_optional_timestamp(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _runtime_search_items_from_result(
    *,
    result: dict[str, Any],
    device: dict[str, Any],
    device_id: str,
    project_id: Optional[int],
) -> list[RuntimeWorkSearchItem]:
    raw_items = result.get("items", [])
    if not isinstance(raw_items, list):
        return []

    items: list[RuntimeWorkSearchItem] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        workspace_path = str(raw_item.get("workspacePath") or "").strip()
        local_task_id = str(raw_item.get("taskId") or "").strip()
        if not workspace_path or not local_task_id:
            continue
        project = _runtime_search_project_ref(device_id, workspace_path)
        if project_id is not None and (project is None or project.id != project_id):
            continue
        items.append(
            RuntimeWorkSearchItem(
                address=RuntimeTaskAddress(
                    deviceId=device_id,
                    workspacePath=workspace_path,
                    localTaskId=local_task_id,
                ),
                runtime=raw_item.get("runtime") or "codex",
                title=str(raw_item.get("title") or local_task_id),
                snippet=str(raw_item.get("snippet") or ""),
                matchStart=int(raw_item.get("matchStart") or 0),
                matchEnd=int(raw_item.get("matchEnd") or 0),
                messageId=str(raw_item.get("messageId") or ""),
                messageRole=str(raw_item.get("messageRole") or ""),
                messageCreatedAt=raw_item.get("messageCreatedAt"),
                updatedAt=raw_item.get("updatedAt"),
                deviceName=_device_name(device, device_id),
                workspacePath=workspace_path,
                project=project,
            )
        )
    return items


def _runtime_search_project_ref(
    device_id: str,
    workspace_path: str,
) -> Optional[RuntimeWorkSearchProjectRef]:
    if _runtime_workspace_kind_fields(workspace_path)["workspaceKind"] == "chat":
        return None
    project = _runtime_project_ref_from_workspace(device_id, workspace_path)
    return RuntimeWorkSearchProjectRef(
        id=_runtime_project_ui_id(project),
        name=project.name,
    )


def _runtime_project_ui_id(project: RuntimeProjectRef) -> int:
    hash_value = 0
    for char in project.key:
        hash_value = (hash_value * 31 + ord(char)) & 0xFFFFFFFF
    return (hash_value % 1_000_000_000) + 1


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
        raw_tasks = item.get("tasks")
        if not isinstance(raw_tasks, list):
            logger.warning(
                "[RuntimeWork] Runtime workspace missing tasks: workspace_path=%s keys=%s",
                path,
                sorted(item.keys()),
            )
            continue
        normalized.append(
            {
                "workspacePath": path,
                "tasks": raw_tasks,
                "label": _runtime_workspace_label(item),
                "workspaceSource": _runtime_workspace_source(item),
                "remoteHostId": _runtime_workspace_remote_host_id(item),
            }
        )
    return normalized


def _runtime_workspace_label(workspace: dict[str, Any]) -> Optional[str]:
    label = workspace.get("label")
    return label.strip() if isinstance(label, str) and label.strip() else None


def _runtime_workspace_source(workspace: dict[str, Any]) -> Optional[str]:
    source = workspace.get("workspaceSource") or workspace.get("workspace_source")
    if not isinstance(source, str):
        return None
    normalized = source.strip().lower()
    return normalized if normalized in {"local", "remote"} else None


def _runtime_workspace_remote_host_id(workspace: dict[str, Any]) -> Optional[str]:
    host_id = workspace.get("remoteHostId") or workspace.get("remote_host_id")
    return host_id.strip() if isinstance(host_id, str) and host_id.strip() else None


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


def _runtime_task_kind_fields(
    task: dict[str, Any],
    workspace_path: str,
) -> dict[str, Optional[str]]:
    workspace_kind = task.get("workspaceKind") or task.get("workspace_kind")
    if workspace_kind in {"workspace", "worktree", "chat"}:
        worktree_id = task.get("worktreeId") or task.get("worktree_id")
        return {
            "workspaceKind": workspace_kind,
            "worktreeId": (
                str(worktree_id).strip()
                if workspace_kind == "worktree"
                and isinstance(worktree_id, str)
                and worktree_id.strip()
                else None
            ),
        }
    return _runtime_workspace_kind_fields(workspace_path)


def _runtime_workspace_kind_fields_from_tasks(
    workspace_path: str,
    local_tasks: list[LocalTaskSummary],
) -> dict[str, Optional[str]]:
    if any(task.workspace_kind == "chat" for task in local_tasks):
        return {"workspaceKind": "chat", "worktreeId": None}
    worktree_task = next(
        (task for task in local_tasks if task.workspace_kind == "worktree"),
        None,
    )
    if worktree_task:
        return {
            "workspaceKind": "worktree",
            "worktreeId": worktree_task.worktree_id,
        }
    return _runtime_workspace_kind_fields(workspace_path)


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


def _path_basename(path: str) -> str:
    parts = [part for part in normalize_workspace_path(path).split("/") if part]
    return parts[-1] if parts else ""


def _runtime_project_ref_from_workspace(
    device_id: str,
    workspace_path: str,
    *,
    label: Optional[str] = None,
) -> RuntimeProjectRef:
    normalized_path = normalize_workspace_path(workspace_path)
    display_name = (
        label.strip()
        if isinstance(label, str) and label.strip()
        else _path_basename(normalized_path) or normalized_path
    )
    return RuntimeProjectRef(
        key=_runtime_workspace_key(device_id, normalized_path),
        name=display_name,
        description=normalized_path,
        color=None,
    )


def _runtime_workspace_key(device_id: str, workspace_path: str) -> str:
    return f"{device_id}:{normalize_workspace_path(workspace_path)}"


def _device_name(device: Optional[dict[str, Any]], fallback: str) -> str:
    if not device:
        return fallback
    name = device.get("name")
    return str(name) if name else fallback


def _archived_device_source(device: Optional[dict[str, Any]]) -> str:
    return "local" if _device_type(device) == "local" else "cloud"


def _device_type(device: Optional[dict[str, Any]]) -> str:
    if not device:
        return ""
    raw_type = (
        device.get("device_type")
        or device.get("deviceType")
        or device.get("type")
        or ""
    )
    if hasattr(raw_type, "value"):
        raw_type = raw_type.value
    normalized = str(raw_type).strip().lower()
    return "local" if normalized == "app" else normalized


def _device_address(device: Optional[dict[str, Any]], fallback: str) -> str:
    if not device:
        return fallback

    for key in (
        "runtime_transfer_host",
        "runtimeTransferHost",
        "client_ip",
        "clientIp",
        "ip",
        "ip_address",
        "ipAddress",
        "private_ip",
        "privateIp",
        "public_ip",
        "publicIp",
        "host",
        "hostname",
    ):
        value = _string_value(device.get(key))
        if value:
            return value

    for config_key in ("remote_config", "remoteConfig", "cloud_config", "cloudConfig"):
        config = device.get(config_key)
        if not isinstance(config, dict):
            continue
        for key in (
            "ip",
            "ipAddress",
            "host",
            "hostname",
            "deviceId",
            "deviceName",
        ):
            value = _string_value(config.get(key))
            if value:
                return value

    return _string_value(device.get("device_id")) or fallback


def _device_status(device: Optional[dict[str, Any]]) -> str:
    if not device:
        return "unavailable"
    status_value = device.get("status")
    return str(status_value) if status_value else "offline"


def _timestamp_from_iso(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _normalized_address(address: RuntimeTaskAddress) -> RuntimeTaskAddress:
    workspace_path = (
        normalize_workspace_path(address.workspace_path)
        if address.workspace_path
        else None
    )
    return RuntimeTaskAddress(
        deviceId=address.device_id,
        workspacePath=workspace_path,
        localTaskId=address.local_task_id.strip(),
    )


def _runtime_task_address_payload(address: RuntimeTaskAddress) -> dict[str, Any]:
    return address.model_dump(by_alias=True, exclude_none=True)


def _runtime_transcript_payload(
    request: RuntimeTranscriptRequest,
    normalized_address: RuntimeTaskAddress,
) -> dict[str, Any]:
    payload = _runtime_task_address_payload(normalized_address)
    limit = getattr(request, "limit", None)
    before_cursor = getattr(request, "before_cursor", None)
    after_cursor = getattr(request, "after_cursor", None)
    include_full_content = getattr(request, "include_full_content", False)
    if limit is not None:
        payload["limit"] = limit
    if before_cursor:
        payload["beforeCursor"] = before_cursor
    if after_cursor:
        payload["afterCursor"] = after_cursor
    if include_full_content:
        payload["includeFullContent"] = True
    return payload


def _runtime_message_count(result: dict[str, Any], key: str) -> int | None:
    messages = result.get("messages")
    if not isinstance(messages, list):
        return None
    snake_key = "file_changes" if key == "fileChanges" else "subtask_id"
    return sum(
        1
        for message in messages
        if isinstance(message, dict)
        and (message.get(key) is not None or message.get(snake_key) is not None)
    )


def _runtime_file_changes_with_status(
    summary: TurnFileChangesSummary,
    status_value: str,
) -> dict[str, Any]:
    updated = summary.model_dump(mode="json")
    updated["status"] = status_value
    if status_value == "reverted":
        updated["reverted_at"] = datetime.now(timezone.utc).isoformat()
    return updated


def _runtime_file_changes_summary_payload(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item for key, item in value.items() if key not in {"diff", "revertible"}
    }


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
            checkout_path = config.workspace.checkoutPath
            workspace_path = (
                checkout_path
                if checkout_path and posixpath.isabs(checkout_path)
                else f"projects/{checkout_path}" if checkout_path else None
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


def _device_workspace_runtime_target(
    *,
    db: Session,
    user_id: int,
    project: Project,
    device_workspace_id: int,
) -> RuntimeTaskTarget:
    mapping = get_device_workspace_kind_by_id(
        db=db,
        user_id=user_id,
        workspace_id=device_workspace_id,
    )
    if mapping is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device workspace not found",
        )
    if mapping.project_id != project.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device workspace does not belong to project",
        )

    workspace_source = "local_path"
    config = _parse_project_config(project, strict=False)
    if config and config.workspace:
        workspace_source = config.workspace.source

    return RuntimeTaskTarget(
        device_id=mapping.device_id,
        workspace_path=normalize_workspace_path(mapping.workspace_path),
        project=project,
        workspace_source=workspace_source,
    )


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
        if request.device_workspace_id is not None:
            return _device_workspace_runtime_target(
                db=db,
                user_id=user_id,
                project=project,
                device_workspace_id=request.device_workspace_id,
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
        detail="projectId + deviceWorkspaceId or deviceId + workspacePath is required",
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
        db,
        user_id,
        request,
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
    db: Session,
    user_id: int,
    request: RuntimeTaskCreateRequest,
) -> tuple[Optional[dict[str, Any]], Optional[str], bool]:
    if not request.model_id:
        return None, None, False
    if request.runtime == "codex" and request.model_type == RUNTIME_MODEL_TYPE:
        from app.services.chat.trigger.unified import (
            _build_codex_runtime_model_config,
        )

        config = _build_codex_runtime_model_config(
            request.model_id,
            dict(request.model_options),
            db=db,
            user_id=user_id,
        )
        return config, None, False
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

    execution_request.attachments = _runtime_attachment_payloads(
        db,
        user_id,
        attachment_ids,
    )


def _runtime_attachment_payloads(
    db: Session,
    user_id: int,
    attachment_ids: list[int],
) -> list[dict[str, Any]]:
    if not attachment_ids:
        return []

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
    return [
        {
            "id": context.id,
            "original_filename": context.original_filename,
            "mime_type": context.mime_type,
            "file_size": context.file_size,
            "subtask_id": context.subtask_id,
            "file_extension": context.file_extension,
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
    if not address.workspace_path:
        return None
    return touch_device_workspace_kind(
        db=db,
        user_id=user_id,
        device_id=address.device_id,
        workspace_path_hash=workspace_path_hash(address.workspace_path),
    )
