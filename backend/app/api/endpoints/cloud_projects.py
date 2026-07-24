# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared cloud project endpoints."""

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.cloud_file import (
    CloudFileAccessResponse,
    CloudFileListResponse,
    CloudFileMove,
    CloudFileResponse,
    CloudFolderCreate,
    ProjectDeliveryFileListResponse,
    ProjectDeliveryFileResponse,
)
from app.schemas.cloud_project import (
    CloudProjectCreate,
    CloudProjectListResponse,
    CloudProjectMemberCreate,
    CloudProjectMemberResponse,
    CloudProjectMemberUpdate,
    CloudProjectResponse,
    CloudProjectUpdate,
    LocalBindingCreate,
    LocalBindingResponse,
)
from app.services.cloud_files import cloud_file_service
from app.services.cloud_projects import cloud_project_service

router = APIRouter()


@router.post(
    "", response_model=CloudProjectResponse, status_code=status.HTTP_201_CREATED
)
def create_cloud_project(
    values: CloudProjectCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectResponse:
    project = cloud_project_service.create(db, current_user.id, values)
    return CloudProjectResponse.model_validate(project)


@router.get("", response_model=CloudProjectListResponse)
def list_cloud_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectListResponse:
    projects = cloud_project_service.list_accessible(db, current_user.id)
    return CloudProjectListResponse(
        items=[CloudProjectResponse.model_validate(project) for project in projects]
    )


@router.get("/{project_id}", response_model=CloudProjectResponse)
def get_cloud_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectResponse:
    project = cloud_project_service.get(db, project_id, current_user.id)
    return CloudProjectResponse.model_validate(project)


@router.patch("/{project_id}", response_model=CloudProjectResponse)
def update_cloud_project(
    project_id: int,
    values: CloudProjectUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectResponse:
    project = cloud_project_service.update(db, project_id, current_user.id, values)
    return CloudProjectResponse.model_validate(project)


@router.post(
    "/{project_id}/local-bindings",
    response_model=LocalBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_local_binding(
    project_id: int,
    values: LocalBindingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LocalBindingResponse:
    binding = cloud_project_service.add_local_binding(
        db, project_id, current_user.id, values
    )
    return LocalBindingResponse.model_validate(binding)


@router.get("/{project_id}/local-bindings", response_model=list[LocalBindingResponse])
def list_local_bindings(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[LocalBindingResponse]:
    bindings = cloud_project_service.list_local_bindings(
        db, project_id, current_user.id
    )
    return [LocalBindingResponse.model_validate(binding) for binding in bindings]


@router.get("/{project_id}/members", response_model=list[CloudProjectMemberResponse])
def list_cloud_project_members(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CloudProjectMemberResponse]:
    members = cloud_project_service.list_members(db, project_id, current_user.id)
    return [CloudProjectMemberResponse.model_validate(member) for member in members]


@router.post(
    "/{project_id}/members",
    response_model=CloudProjectMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_cloud_project_member(
    project_id: int,
    values: CloudProjectMemberCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectMemberResponse:
    member = cloud_project_service.add_member(db, project_id, current_user.id, values)
    return CloudProjectMemberResponse.model_validate(member)


@router.patch(
    "/{project_id}/members/{member_user_id}",
    response_model=CloudProjectMemberResponse,
)
def update_cloud_project_member(
    project_id: int,
    member_user_id: int,
    values: CloudProjectMemberUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudProjectMemberResponse:
    member = cloud_project_service.update_member(
        db, project_id, member_user_id, current_user.id, values
    )
    return CloudProjectMemberResponse.model_validate(member)


@router.delete(
    "/{project_id}/members/{member_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_cloud_project_member(
    project_id: int,
    member_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    cloud_project_service.remove_member(db, project_id, member_user_id, current_user.id)


@router.get("/{project_id}/files", response_model=CloudFileListResponse)
def list_cloud_files(
    project_id: int,
    prefix: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileListResponse:
    files = cloud_file_service.list(db, project_id, current_user.id, prefix)
    return CloudFileListResponse(
        items=[CloudFileResponse.model_validate(file) for file in files]
    )


@router.get(
    "/{project_id}/delivery-files", response_model=ProjectDeliveryFileListResponse
)
def list_project_delivery_files(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectDeliveryFileListResponse:
    rows = cloud_file_service.list_delivery_files(db, project_id, current_user.id)
    return ProjectDeliveryFileListResponse(
        items=[
            ProjectDeliveryFileResponse(
                asset_id=asset.id,
                delivery_id=delivery.id,
                loop_item_id=item.id,
                loop_item_title=item.title,
                relative_path=asset.relative_path,
                display_name=asset.display_name,
                content_type=asset.content_type,
                size_bytes=asset.size_bytes,
                delivered_at=delivery.delivered_at,
            )
            for asset, delivery, item in rows
            if delivery.delivered_at is not None
        ]
    )


@router.post(
    "/{project_id}/folders",
    response_model=CloudFileResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_cloud_folder(
    project_id: int,
    values: CloudFolderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileResponse:
    folder = cloud_file_service.create_folder(
        db, project_id, current_user.id, values.path, values.description
    )
    return CloudFileResponse.model_validate(folder)


@router.post(
    "/{project_id}/files",
    response_model=CloudFileResponse,
    status_code=status.HTTP_201_CREATED,
)
def upload_cloud_file(
    project_id: int,
    file: UploadFile = File(...),
    path: str = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileResponse:
    uploaded = cloud_file_service.upload(
        db,
        project_id,
        current_user.id,
        path,
        file.content_type or "application/octet-stream",
        file.file,
    )
    return CloudFileResponse.model_validate(uploaded)


@router.get("/files/{file_id}/access", response_model=CloudFileAccessResponse)
def access_cloud_file(
    file_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileAccessResponse:
    return CloudFileAccessResponse(
        url=cloud_file_service.access_url(db, file_id, current_user.id)
    )


@router.patch("/files/{file_id}", response_model=CloudFileResponse)
def move_cloud_file(
    file_id: int,
    values: CloudFileMove,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudFileResponse:
    file = cloud_file_service.move(
        db, file_id, current_user.id, values.path, values.version
    )
    return CloudFileResponse.model_validate(file)


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cloud_file(
    file_id: int,
    recursive: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    cloud_file_service.delete(db, file_id, current_user.id, recursive)
