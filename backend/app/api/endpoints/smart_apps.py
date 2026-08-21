# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Smart app marketplace and restricted publication API."""

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
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
from app.services.marketplace_artifact_storage import MarketplaceArtifactStorageError
from app.services.smart_app_marketplace_service import smart_app_marketplace_service

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
