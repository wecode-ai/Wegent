# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime-native local work endpoints for Wework."""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.constants import CLIENT_ORIGIN_WEWORK, SUPPORTED_CLIENT_ORIGINS
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.runtime_work import (
    BindRuntimeTaskIMSessionsRequest,
    BindRuntimeTaskIMSessionsResponse,
    DeviceWorkspacePrepareRequest,
    DeviceWorkspacePrepareResponse,
    DeviceWorkspaceResponse,
    DeviceWorkspaceUpsert,
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
from app.services import runtime_work_service
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_async,
)

router = APIRouter()

ClientOriginQuery = Annotated[
    str,
    Query(
        pattern=f"^({'|'.join(SUPPORTED_CLIENT_ORIGINS)})$",
        description="Client surface to scope projects",
    ),
]


@router.get("", response_model=RuntimeWorkListResponse, response_model_by_alias=True)
async def list_runtime_work_endpoint(
    client_origin: ClientOriginQuery = CLIENT_ORIGIN_WEWORK,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List Projects -> Device Workspaces -> executor-local LocalTasks."""

    return await runtime_work_service.list_runtime_work(
        db=db,
        user_id=current_user.id,
        client_origin=client_origin,
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


@router.post(
    "/transcript",
    response_model=RuntimeTranscriptResponse,
    response_model_by_alias=True,
)
async def get_runtime_transcript_endpoint(
    address: RuntimeTaskAddress,
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
