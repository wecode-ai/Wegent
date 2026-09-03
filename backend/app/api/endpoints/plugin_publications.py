# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Wework plugin publication request endpoints."""

from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.marketplace_upload import read_marketplace_package
from app.core import security
from app.models.user import User
from app.schemas.plugin_publication import (
    PluginPublicationCreateRequest,
    PluginPublicationRequestDetail,
    PluginPublicationRequestListResponse,
    PluginPublicationRevisionCreateRequest,
    PluginPublicationUploadResponse,
)
from app.services.marketplace_submission_upload import (
    InvalidMarketplaceSubmissionUploadToken,
    verify_plugin_publication_upload_token,
)
from app.services.plugin_package_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.plugin_package_storage import PluginPackageStorageError
from app.services.plugin_publication_idempotency import (
    plugin_publication_idempotency_service,
)
from app.services.plugin_publication_service import plugin_publication_service
from shared.telemetry.decorators import trace_async

router = APIRouter(tags=["plugin-publications"])


@router.post(
    "/publication-requests",
    response_model=PluginPublicationUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_plugin_publication_request(
    request: PluginPublicationCreateRequest,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginPublicationUploadResponse:
    user_id = current_user.id
    try:
        return plugin_publication_idempotency_service.execute(
            db,
            principal_type="user",
            principal_id=user_id,
            operation="publication_request.create",
            idempotency_key=idempotency_key,
            resource_key=f"source:{request.sourcePluginId or request.slug}",
            payload=request,
            response_model=PluginPublicationUploadResponse,
            action=lambda: plugin_publication_service.create_request(
                db, user_id=user_id, payload=request
            ),
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.get(
    "/publication-requests", response_model=PluginPublicationRequestListResponse
)
def list_plugin_publication_requests(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    source_plugin_id: int | None = Query(default=None, alias="sourcePluginId", gt=0),
    active_only: bool = Query(default=False, alias="activeOnly"),
    submitted_after: datetime | None = Query(default=None, alias="submittedAfter"),
    submitted_before: datetime | None = Query(default=None, alias="submittedBefore"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginPublicationRequestListResponse:
    return plugin_publication_service.list_requests(
        db,
        user_id=current_user.id,
        is_admin=False,
        page=page,
        limit=limit,
        source_plugin_id=source_plugin_id,
        active_only=active_only,
        submitted_after=submitted_after,
        submitted_before=submitted_before,
    )


@router.get(
    "/publication-requests/{request_id}",
    response_model=PluginPublicationRequestDetail,
)
def get_plugin_publication_request(
    request_id: int,
    revision: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginPublicationRequestDetail:
    return plugin_publication_service.get_request(
        db,
        user_id=current_user.id,
        request_id=request_id,
        revision_number=revision,
    )


@router.post(
    "/publication-requests/{request_id}/revisions",
    response_model=PluginPublicationUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_plugin_publication_revision(
    request_id: int,
    request: PluginPublicationRevisionCreateRequest,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginPublicationUploadResponse:
    user_id = current_user.id
    try:
        return plugin_publication_idempotency_service.execute(
            db,
            principal_type="user",
            principal_id=user_id,
            operation="publication_revision.create",
            idempotency_key=idempotency_key,
            resource_key=f"request:{request_id}",
            payload=request,
            response_model=PluginPublicationUploadResponse,
            action=lambda: plugin_publication_service.create_revision(
                db,
                user_id=user_id,
                request_id=request_id,
                payload=request,
            ),
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.put(
    "/publication-requests/{request_id}/revisions/{revision}/artifact",
    status_code=204,
)
@trace_async("upload_plugin_publication_artifact", "marketplace.api")
async def upload_plugin_publication_revision(
    request_id: int,
    revision: int,
    request: Request,
    token: str = Query(..., description="Short-lived publication upload token"),
    db: Session = Depends(get_db),
) -> Response:
    """Upload a ticketed publication snapshot through the Backend origin."""
    try:
        claims = verify_plugin_publication_upload_token(token)
    except InvalidMarketplaceSubmissionUploadToken as exc:
        raise HTTPException(
            status_code=403, detail="Invalid or expired publication upload link"
        ) from exc
    if claims.request_id != request_id or claims.revision != revision:
        raise HTTPException(
            status_code=403, detail="Invalid or expired publication upload link"
        )

    package = await read_marketplace_package(
        request,
        max_bytes=MAX_PLUGIN_PACKAGE_SIZE_BYTES,
        resource_name="Plugin",
    )
    try:
        plugin_publication_service.upload_revision_package(
            db,
            user_id=claims.user_id,
            request_id=request_id,
            revision_number=revision,
            package=package,
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc
    return Response(status_code=204)


@router.post(
    "/publication-requests/{request_id}/revisions/{revision}/complete",
    response_model=PluginPublicationRequestDetail,
)
def complete_plugin_publication_revision(
    request_id: int,
    revision: int,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginPublicationRequestDetail:
    user_id = current_user.id
    try:
        return plugin_publication_idempotency_service.execute(
            db,
            principal_type="user",
            principal_id=user_id,
            operation="publication_revision.complete",
            idempotency_key=idempotency_key,
            resource_key=f"request:{request_id}:revision:{revision}",
            payload={},
            response_model=PluginPublicationRequestDetail,
            action=lambda: plugin_publication_service.complete_revision(
                db,
                user_id=user_id,
                request_id=request_id,
                revision_number=revision,
            ),
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.post(
    "/publication-requests/{request_id}/withdraw",
    response_model=PluginPublicationRequestDetail,
)
def withdraw_plugin_publication_request(
    request_id: int,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginPublicationRequestDetail:
    user_id = current_user.id
    return plugin_publication_idempotency_service.execute(
        db,
        principal_type="user",
        principal_id=user_id,
        operation="publication_request.withdraw",
        idempotency_key=idempotency_key,
        resource_key=f"request:{request_id}",
        payload={},
        response_model=PluginPublicationRequestDetail,
        action=lambda: plugin_publication_service.withdraw_request(
            db, user_id=user_id, request_id=request_id
        ),
    )
