# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project incoming hook management and public ingestion endpoints."""

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.delivery import ProjectIncomingHook
from app.models.user import User
from app.schemas.project_incoming_hook import (
    ProjectIncomingHookCreate,
    ProjectIncomingHookUpdate,
    ProjectIncomingHookView,
    ProjectIncomingReceipt,
)
from app.services.project_incoming_hooks import project_incoming_hook_service

router = APIRouter()
public_router = APIRouter()


def _view(request: Request, hook: ProjectIncomingHook) -> ProjectIncomingHookView:
    return ProjectIncomingHookView(
        id=str(hook.id),
        project_id=str(hook.cloud_project_id),
        name=hook.name or "",
        status=hook.status or "disabled",
        webhook_url=str(
            request.url_for("receive_project_incoming_hook", token=hook.public_id)
        ),
        version=hook.version,
        created_at=hook.created_at,
        updated_at=hook.updated_at,
    )


@router.get(
    "/{project_id}/incoming-hooks",
    response_model=list[ProjectIncomingHookView],
)
def list_incoming_hooks(
    project_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectIncomingHookView]:
    return [
        _view(request, hook)
        for hook in project_incoming_hook_service.list(db, project_id, current_user.id)
    ]


@router.post(
    "/{project_id}/incoming-hooks",
    response_model=ProjectIncomingHookView,
    status_code=status.HTTP_201_CREATED,
)
def create_incoming_hook(
    project_id: str,
    values: ProjectIncomingHookCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectIncomingHookView:
    hook = project_incoming_hook_service.create(db, project_id, current_user.id, values)
    return _view(request, hook)


@router.patch(
    "/{project_id}/incoming-hooks/{hook_id}",
    response_model=ProjectIncomingHookView,
)
def update_incoming_hook(
    project_id: str,
    hook_id: str,
    values: ProjectIncomingHookUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectIncomingHookView:
    hook = project_incoming_hook_service.update(
        db, project_id, hook_id, current_user.id, values
    )
    return _view(request, hook)


@router.post(
    "/{project_id}/incoming-hooks/{hook_id}/rotate",
    response_model=ProjectIncomingHookView,
)
def rotate_incoming_hook(
    project_id: str,
    hook_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectIncomingHookView:
    hook = project_incoming_hook_service.rotate(
        db, project_id, hook_id, current_user.id
    )
    return _view(request, hook)


@public_router.post(
    "/{token}",
    response_model=ProjectIncomingReceipt,
    status_code=status.HTTP_202_ACCEPTED,
    name="receive_project_incoming_hook",
)
async def receive_project_incoming_hook(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
) -> ProjectIncomingReceipt:
    result = await project_incoming_hook_service.receive(
        db,
        token,
        await request.body(),
        request.headers.get("content-type", ""),
        request.headers,
    )
    return ProjectIncomingReceipt.model_validate(result)
