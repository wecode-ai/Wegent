# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal object storage endpoints."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.services.object_storage import (
    InvalidObjectNameError,
    InvalidSkillIdentityError,
    ObjectStorageDownloadGrant,
    ObjectStoragePermissionError,
    TaskScopeNotFoundError,
    object_storage_upload_grant_service,
)

router = APIRouter(prefix="/object-storage", tags=["internal-object-storage"])


class UploadURLRequest(BaseModel):
    """Request a presigned upload URL for one object."""

    task_id: int = Field(..., description="Task ID owning the storage scope")
    object_name: str = Field(..., description="Artifact file name, for example app.zip")
    skill_identity_token: str = Field(..., description="Skill identity JWT")


class UploadURLResponse(BaseModel):
    """Presigned upload URL response."""

    upload_url: str
    object_key: str
    expires_at: datetime


class DownloadURLRequest(BaseModel):
    """Request a presigned download URL for one object."""

    task_id: int = Field(..., description="Task ID owning the storage scope")
    object_name: str = Field(..., description="Artifact file name, for example app.zip")
    skill_identity_token: str = Field(..., description="Skill identity JWT")


class DownloadURLResponse(BaseModel):
    """Presigned download URL response."""

    download_url: str
    object_key: str
    expires_at: datetime


@router.post("/upload-url", response_model=UploadURLResponse)
def create_upload_url(
    request: UploadURLRequest,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
) -> UploadURLResponse:
    """Issue a presigned upload URL scoped to one object."""
    try:
        grant = object_storage_upload_grant_service.create_upload_grant(
            db=db,
            auth_context=auth_context,
            skill_identity_token=request.skill_identity_token,
            task_id=request.task_id,
            object_name=request.object_name,
        )
    except InvalidObjectNameError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except InvalidSkillIdentityError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ObjectStoragePermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except TaskScopeNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return UploadURLResponse(
        upload_url=grant.upload_url,
        object_key=grant.object_key,
        expires_at=grant.expires_at,
    )


@router.post("/download-url", response_model=DownloadURLResponse)
def create_download_url(
    request: DownloadURLRequest,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
) -> DownloadURLResponse:
    """Issue a presigned download URL scoped to one object."""
    try:
        grant: ObjectStorageDownloadGrant = (
            object_storage_upload_grant_service.create_download_grant(
                db=db,
                auth_context=auth_context,
                skill_identity_token=request.skill_identity_token,
                task_id=request.task_id,
                object_name=request.object_name,
            )
        )
    except InvalidObjectNameError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except InvalidSkillIdentityError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ObjectStoragePermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except TaskScopeNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return DownloadURLResponse(
        download_url=grant.download_url,
        object_key=grant.object_key,
        expires_at=grant.expires_at,
    )
