# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Smart app marketplace and restricted publication API."""

from typing import NoReturn
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.marketplace_upload import read_marketplace_package
from app.core import security
from app.models.user import User
from app.schemas.smart_app import (
    SmartAppAccessResponse,
    SmartAppAccessUpdateRequest,
    SmartAppDownloadDescriptor,
    SmartAppMarketplaceItem,
    SmartAppMarketplaceListResponse,
    SmartAppOwnedListResponse,
    SmartAppSubmissionCompleteResponse,
    SmartAppSubmissionInitRequest,
    SmartAppSubmissionInitResponse,
    SmartAppSubmissionItem,
)
from app.services.marketplace_artifact_storage import (
    MarketplaceArtifactStorageError,
    marketplace_artifact_storage,
)
from app.services.marketplace_submission_upload import (
    InvalidMarketplaceSubmissionUploadToken,
    verify_marketplace_submission_upload_token,
)
from app.services.smart_app_download_link import (
    InvalidSmartAppDownloadToken,
    verify_smart_app_download_token,
)
from app.services.smart_app_marketplace_service import smart_app_marketplace_service
from app.services.smart_app_package_parser import MAX_SMART_APP_PACKAGE_SIZE_BYTES
from shared.telemetry.decorators import trace_async

router = APIRouter(tags=["smart-apps"])


def _raise_storage_unavailable(exc: MarketplaceArtifactStorageError) -> NoReturn:
    raise HTTPException(
        status_code=503,
        detail={
            "code": "smart_app_storage_unavailable",
            "message": "Smart app file storage is unavailable",
        },
    ) from exc


@router.get("/marketplace", response_model=SmartAppMarketplaceListResponse)
def list_marketplace(
    q: str = "",
    source: str = "",
    tag: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppMarketplaceListResponse:
    try:
        return smart_app_marketplace_service.list_marketplace(
            db, user_id=current_user.id, query=q, source=source, tag=tag
        )
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)


@router.get("/owned", response_model=SmartAppOwnedListResponse)
def list_owned(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppOwnedListResponse:
    try:
        return smart_app_marketplace_service.list_owned(db, user_id=current_user.id)
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)


@router.get("/marketplace/{smart_app_id}", response_model=SmartAppMarketplaceItem)
def get_marketplace_item(
    smart_app_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppMarketplaceItem:
    try:
        return smart_app_marketplace_service.get_marketplace_item(
            db, smart_app_id=smart_app_id, user_id=current_user.id
        )
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)


@router.post(
    "/marketplace/{smart_app_id}/download",
    response_model=SmartAppDownloadDescriptor,
)
def download_marketplace_item(
    smart_app_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppDownloadDescriptor:
    try:
        return smart_app_marketplace_service.download_descriptor(
            db, smart_app_id=smart_app_id, user_id=current_user.id
        )
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)


@router.get("/marketplace/{smart_app_id}/artifact")
def download_marketplace_artifact(
    smart_app_id: int,
    token: str = Query(..., description="Short-lived Smart app download token"),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Stream a ticketed Smart app package through the Backend HTTPS origin."""
    try:
        claims = verify_smart_app_download_token(token)
    except InvalidSmartAppDownloadToken as exc:
        raise HTTPException(
            status_code=403, detail="Invalid or expired Smart app download link"
        ) from exc
    if claims.smart_app_id != smart_app_id:
        raise HTTPException(
            status_code=403, detail="Invalid or expired Smart app download link"
        )

    try:
        artifact = smart_app_marketplace_service.download_artifact(
            db,
            smart_app_id=smart_app_id,
            release_id=claims.release_id,
            user_id=claims.user_id,
        )
        chunks = marketplace_artifact_storage.open_download(artifact.storage_key)
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)

    encoded_filename = quote(artifact.filename, safe="")
    return StreamingResponse(
        chunks,
        media_type="application/zip",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            "Content-Length": str(artifact.size_bytes),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/submissions/init", response_model=SmartAppSubmissionInitResponse)
def init_submission(
    request: SmartAppSubmissionInitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppSubmissionInitResponse:
    try:
        return smart_app_marketplace_service.init_submission(
            db, user_id=current_user.id, request=request
        )
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)


@router.put("/submissions/{submission_id}/artifact", status_code=204)
@trace_async("upload_smart_app_submission_artifact", "marketplace.api")
async def upload_submission_artifact(
    submission_id: int,
    request: Request,
    token: str = Query(..., description="Short-lived Smart app upload token"),
    db: Session = Depends(get_db),
) -> Response:
    """Upload a ticketed Smart app package through the Backend origin."""
    try:
        claims = verify_marketplace_submission_upload_token(
            token, expected_kind="smart_app"
        )
    except InvalidMarketplaceSubmissionUploadToken as exc:
        raise HTTPException(
            status_code=403, detail="Invalid or expired Smart app upload link"
        ) from exc
    if claims.submission_id != submission_id:
        raise HTTPException(
            status_code=403, detail="Invalid or expired Smart app upload link"
        )

    package = await read_marketplace_package(
        request,
        max_bytes=MAX_SMART_APP_PACKAGE_SIZE_BYTES,
        resource_name="Smart app",
    )
    try:
        smart_app_marketplace_service.upload_submission_package(
            db,
            submission_id=submission_id,
            user_id=claims.user_id,
            package=package,
        )
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)
    return Response(status_code=204)


@router.post(
    "/submissions/{submission_id}/complete",
    response_model=SmartAppSubmissionCompleteResponse,
)
def complete_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppSubmissionCompleteResponse:
    try:
        return smart_app_marketplace_service.complete_submission(
            db, submission_id=submission_id, user_id=current_user.id
        )
    except MarketplaceArtifactStorageError as exc:
        _raise_storage_unavailable(exc)


@router.post(
    "/submissions/{submission_id}/cancel",
    response_model=SmartAppSubmissionItem,
)
def cancel_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppSubmissionItem:
    return smart_app_marketplace_service.cancel_submission(
        db, submission_id=submission_id, user_id=current_user.id
    )


@router.get("/{smart_app_id}/access", response_model=SmartAppAccessResponse)
def get_access(
    smart_app_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppAccessResponse:
    return smart_app_marketplace_service.get_access(
        db, smart_app_id=smart_app_id, user_id=current_user.id
    )


@router.put("/{smart_app_id}/access", response_model=SmartAppAccessResponse)
def update_access(
    smart_app_id: int,
    request: SmartAppAccessUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SmartAppAccessResponse:
    return smart_app_marketplace_service.update_access(
        db,
        smart_app_id=smart_app_id,
        user_id=current_user.id,
        request=request,
    )
