# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime-native local work endpoints for Wework."""

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.runtime_work import (
    BindRuntimeTaskIMSessionsRequest,
    BindRuntimeTaskIMSessionsResponse,
    DeviceWorkspacePrepareRequest,
    DeviceWorkspacePrepareResponse,
    DeviceWorkspaceResponse,
    DeviceWorkspaceUpsert,
    RuntimeFileChangesRevertRequest,
    RuntimeFileChangesRevertResponse,
    RuntimeGlobalIMNotificationUpdateRequest,
    RuntimeIMNotificationSettingsResponse,
    RuntimeSendRequest,
    RuntimeSendResponse,
    RuntimeTaskAddress,
    RuntimeTaskArchiveResponse,
    RuntimeTaskCreateRequest,
    RuntimeTaskCreateResponse,
    RuntimeTaskForkRequest,
    RuntimeTaskForkResponse,
    RuntimeTaskIMNotificationSubscriptionRequest,
    RuntimeTaskIMNotificationSubscriptionResponse,
    RuntimeTranscriptRequest,
    RuntimeTranscriptResponse,
    RuntimeWorkListResponse,
    RuntimeWorkspaceOpenRequest,
    RuntimeWorkspaceOpenResponse,
)
from app.services import runtime_work_service
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_async,
)

router = APIRouter()


@router.get("", response_model=RuntimeWorkListResponse, response_model_by_alias=True)
async def list_runtime_work_endpoint(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List executor-local work grouped as projects and conversations."""

    return await runtime_work_service.list_runtime_work(
        db=db,
        user_id=current_user.id,
    )


@router.get(
    "/device-workspaces",
    response_model=list[DeviceWorkspaceResponse],
    response_model_by_alias=True,
)
def list_device_workspaces_endpoint(
    project_id: int | None = Query(default=None, alias="project_id"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List central Device Workspace mappings for the current user."""

    return runtime_work_service.list_device_workspaces(
        db=db,
        user_id=current_user.id,
        project_id=project_id,
    )


@router.post(
    "/device-workspaces",
    response_model=DeviceWorkspaceResponse,
    response_model_by_alias=True,
)
def upsert_device_workspace_endpoint(
    payload: DeviceWorkspaceUpsert = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or update a central Project-to-device-directory mapping."""

    return runtime_work_service.upsert_device_workspace(
        db=db,
        user_id=current_user.id,
        payload=payload,
    )


@router.post(
    "/device-workspaces/prepare",
    response_model=DeviceWorkspacePrepareResponse,
    response_model_by_alias=True,
)
async def prepare_device_workspace_endpoint(
    payload: DeviceWorkspacePrepareRequest = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Prepare a device folder for one Project and store its mapping."""

    return await runtime_work_service.prepare_device_workspace(
        db=db,
        user_id=current_user.id,
        payload=payload,
    )


@router.delete("/device-workspaces")
def delete_device_workspace_endpoint(
    project_id: int = Query(..., ge=1),
    device_id: str = Query(..., min_length=1),
    workspace_path: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Deactivate one Project-to-device-directory mapping."""

    deleted = runtime_work_service.delete_device_workspace(
        db=db,
        user_id=current_user.id,
        project_id=project_id,
        device_id=device_id,
        workspace_path=workspace_path,
    )
    return {"deleted": deleted}


@router.post(
    "/transcript",
    response_model=RuntimeTranscriptResponse,
    response_model_by_alias=True,
)
async def get_runtime_transcript_endpoint(
    address: RuntimeTranscriptRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read a native runtime transcript from the owning online local executor."""

    return await runtime_work_service.get_runtime_transcript(
        db=db,
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/file-changes/revert",
    response_model=RuntimeFileChangesRevertResponse,
    response_model_by_alias=True,
)
async def revert_runtime_file_changes_endpoint(
    request: RuntimeFileChangesRevertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Revert a native runtime file-change artifact on the owning device."""

    return await runtime_work_service.revert_runtime_file_changes(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/send",
    response_model=RuntimeSendResponse,
    response_model_by_alias=True,
)
async def send_runtime_message_endpoint(
    request: RuntimeSendRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Continue a native runtime LocalTask through the owning local executor."""

    return await runtime_work_service.send_runtime_message(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/im-sessions",
    response_model=BindRuntimeTaskIMSessionsResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.bind_im_sessions", "runtime_work.api")
async def bind_runtime_task_im_sessions_endpoint(
    request: BindRuntimeTaskIMSessionsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bind private IM sessions to a native runtime LocalTask address."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", request.address.device_id)
    set_span_attribute("runtime.local_task_id", request.address.local_task_id)
    set_span_attribute("runtime.im_session_count", len(request.session_keys))
    add_span_event(
        "runtime_work.im_sessions.bind",
        {
            "user.id": current_user.id,
            "runtime.device_id": request.address.device_id,
            "runtime.local_task_id": request.address.local_task_id,
            "runtime.im_session_count": len(request.session_keys),
        },
    )
    return await runtime_work_service.bind_runtime_task_to_im_sessions(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.get(
    "/im-notifications",
    response_model=RuntimeIMNotificationSettingsResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.get", "runtime_work.api")
async def get_im_notification_settings_endpoint(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read global and task-level IM notification settings."""

    set_span_attribute("user.id", current_user.id)
    return await runtime_work_service.get_im_notification_settings(
        db=db,
        user_id=current_user.id,
    )


@router.put(
    "/im-notifications/global",
    response_model=RuntimeIMNotificationSettingsResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.global.update", "runtime_work.api")
async def update_global_im_notification_endpoint(
    request: RuntimeGlobalIMNotificationUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update the user-level IM notification quick switch."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.im_notifications.global.enabled", request.enabled)
    return await runtime_work_service.update_global_im_notification(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.put(
    "/im-notifications/runtime-task",
    response_model=RuntimeTaskIMNotificationSubscriptionResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.runtime_task.subscribe", "runtime_work.api")
async def subscribe_runtime_task_im_notification_endpoint(
    request: RuntimeTaskIMNotificationSubscriptionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Subscribe a runtime LocalTask to private IM notifications."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", request.address.device_id)
    set_span_attribute("runtime.local_task_id", request.address.local_task_id)
    set_span_attribute("runtime.im_session_count", len(request.session_keys))
    return await runtime_work_service.subscribe_runtime_task_im_notification(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/im-notifications/runtime-task/unsubscribe",
    response_model=RuntimeTaskIMNotificationSubscriptionResponse,
    response_model_by_alias=True,
)
@trace_async(
    "runtime_work.im_notifications.runtime_task.unsubscribe", "runtime_work.api"
)
async def unsubscribe_runtime_task_im_notification_endpoint(
    address: RuntimeTaskAddress,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove runtime LocalTask private IM notification subscriptions."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", address.device_id)
    set_span_attribute("runtime.local_task_id", address.local_task_id)
    return await runtime_work_service.unsubscribe_runtime_task_im_notification(
        db=db,
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/archive",
    response_model=RuntimeTaskArchiveResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.archive_task", "runtime_work.api")
async def archive_runtime_task_endpoint(
    address: RuntimeTaskAddress,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Archive a native runtime LocalTask through the owning local executor."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", address.device_id)
    set_span_attribute("runtime.local_task_id", address.local_task_id)
    add_span_event(
        "runtime_work.task.archive",
        {
            "user.id": current_user.id,
            "runtime.device_id": address.device_id,
            "runtime.local_task_id": address.local_task_id,
        },
    )
    return await runtime_work_service.archive_runtime_task(
        db=db,
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/create",
    response_model=RuntimeTaskCreateResponse,
    response_model_by_alias=True,
)
async def create_runtime_task_endpoint(
    request: RuntimeTaskCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a native runtime LocalTask through the owning local executor."""

    return await runtime_work_service.create_runtime_task(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/workspaces/open",
    response_model=RuntimeWorkspaceOpenResponse,
    response_model_by_alias=True,
)
async def open_runtime_workspace_endpoint(
    request: RuntimeWorkspaceOpenRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Open a native runtime workspace without starting a turn."""

    return await runtime_work_service.open_runtime_workspace(
        db=db,
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/fork",
    response_model=RuntimeTaskForkResponse,
    response_model_by_alias=True,
)
async def fork_runtime_task_endpoint(
    request: RuntimeTaskForkRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Fork a native runtime LocalTask to another device workspace."""

    return await runtime_work_service.fork_runtime_task(
        db=db,
        user_id=current_user.id,
        request=request,
    )
