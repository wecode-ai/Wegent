# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework Runtime profile endpoints."""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.runtime_profile import (
    ProjectRuntimeDefaultUpdate,
    ProjectRuntimeDefaultView,
    RuntimeProfileCreate,
    RuntimeProfileUpdate,
    RuntimeProfileView,
)
from app.services.device_service import device_service
from app.services.runtime_profiles import runtime_profile_service

router = APIRouter()
project_router = APIRouter()


@router.get("", response_model=list[RuntimeProfileView])
async def list_runtime_profiles(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RuntimeProfileView]:
    devices = await device_service.get_all_devices(db, current_user.id)
    runtime_profile_service.ensure_device_defaults(db, current_user.id, devices)
    return runtime_profile_service.list(db, current_user.id)


@router.post(
    "",
    response_model=RuntimeProfileView,
    status_code=status.HTTP_201_CREATED,
)
def create_runtime_profile(
    values: RuntimeProfileCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RuntimeProfileView:
    return runtime_profile_service.create(db, current_user.id, values)


@router.patch("/{profile_id}", response_model=RuntimeProfileView)
def update_runtime_profile(
    profile_id: str,
    values: RuntimeProfileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RuntimeProfileView:
    return runtime_profile_service.update(db, current_user.id, profile_id, values)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_runtime_profile(
    profile_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    runtime_profile_service.delete(db, current_user.id, profile_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@project_router.get(
    "/{project_id}/runtime-default",
    response_model=ProjectRuntimeDefaultView,
)
def get_project_runtime_default(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectRuntimeDefaultView:
    return runtime_profile_service.get_project_default(db, project_id, current_user.id)


@project_router.put(
    "/{project_id}/runtime-default",
    response_model=ProjectRuntimeDefaultView,
)
def set_project_runtime_default(
    project_id: str,
    values: ProjectRuntimeDefaultUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectRuntimeDefaultView:
    return runtime_profile_service.set_project_default(
        db, project_id, current_user.id, values.runtime_profile_id
    )
