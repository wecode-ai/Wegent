# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""KB video upload endpoints (two-phase object-storage contract).

KB video uploads bypass the generic ``/attachments/upload`` path (100 MB,
in-memory ``StorageBackend``) and use a two-phase contract:

  1. ``POST /init``    — the backend returns the target the frontend uploads
                         the binary to (provider-specific).
  2. ``POST /complete`` — after the frontend upload, the backend stores only
                         metadata (object key + storage_backend) in type_data.

Open-source default: ``NoOpVideoUploadProvider`` rejects both phases with
``video_upload_not_configured``. Internal deployments register a provider
(e.g. WeiboVideoUploadProvider) via ``register_video_upload_provider()``.

The binary never enters backend memory — this endpoint never receives the
file bytes.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.knowledge.video_upload_provider import (
    VideoUploadNotConfiguredError,
    build_video_upload_provider,
)
from shared.telemetry.decorators import trace_sync

router = APIRouter()


class VideoUploadInitRequest(BaseModel):
    """Phase 1 request: ask the backend for the binary upload target."""

    filename: str
    file_size: int
    file_extension: Optional[str] = None


class VideoUploadCompleteRequest(BaseModel):
    """Phase 2 request: register metadata after the frontend object-storage upload."""

    filename: str
    file_size: int
    file_extension: Optional[str] = None
    # Provider-specific result of the object-storage upload (object key / fid +
    # any extra metadata the provider needs to persist in type_data).
    upload_result: Dict[str, Any]


class VideoUploadCompleteResponse(BaseModel):
    attachment_id: int
    storage_backend: str
    object_key: str


def _not_configured() -> None:
    raise HTTPException(
        status_code=400,
        detail="video_upload_not_configured: KB video upload is not configured",
    )


@router.post("/init")
@trace_sync("video_upload_init", "knowledge.api")
def init_video_upload(
    request: VideoUploadInitRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Return the target the frontend uploads the video binary to."""
    provider = build_video_upload_provider()
    try:
        target = provider.init_upload(
            filename=request.filename,
            file_size=request.file_size,
            file_extension=request.file_extension or "",
            uploader=current_user,
        )
    except VideoUploadNotConfiguredError:
        _not_configured()
        return {}  # unreachable — _not_configured raises
    return {
        "upload_url": target.upload_url,
        "method": target.method,
        "headers": target.headers,
        "extra": target.extra,
    }


@router.post("/complete")
@trace_sync("video_upload_complete", "knowledge.api")
def complete_video_upload(
    request: VideoUploadCompleteRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> VideoUploadCompleteResponse:
    """Register video metadata after the frontend object-storage upload."""
    provider = build_video_upload_provider()
    try:
        result = provider.complete_upload(
            upload_result=request.upload_result,
            filename=request.filename,
            file_size=request.file_size,
            file_extension=request.file_extension or "",
            uploader=current_user,
        )
    except VideoUploadNotConfiguredError:
        _not_configured()
        return VideoUploadCompleteResponse(  # unreachable
            attachment_id=0, storage_backend="", object_key=""
        )
    return VideoUploadCompleteResponse(
        attachment_id=result.attachment_id,
        storage_backend=result.storage_backend,
        object_key=result.object_key,
    )
