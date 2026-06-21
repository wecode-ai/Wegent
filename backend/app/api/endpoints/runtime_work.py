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
    DeviceWorkspaceResponse,
    DeviceWorkspaceUpsert,
    RuntimeSendRequest,
    RuntimeSendResponse,
    RuntimeTaskAddress,
    RuntimeTaskArchiveResponse,
    RuntimeTaskCreateRequest,
    RuntimeTaskCreateResponse,
    RuntimeTranscriptResponse,
    RuntimeWorkListResponse,
)
from app.services import runtime_work_service

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
async def bind_runtime_task_im_sessions_endpoint(
    request: BindRuntimeTaskIMSessionsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bind private IM sessions to a native runtime LocalTask address."""

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
async def archive_runtime_task_endpoint(
    address: RuntimeTaskAddress,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Archive a native runtime LocalTask through the owning local executor."""

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
