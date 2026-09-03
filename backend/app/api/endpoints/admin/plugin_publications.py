# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web administrator endpoints for enterprise plugin publication."""

from datetime import datetime

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.plugin_publication import (
    AcceptPluginPublicationRequest,
    PluginPublicationRequestDetail,
    PluginPublicationRequestListResponse,
    ReconcilePluginPublicationRequest,
    ReturnPluginPublicationRequest,
)
from app.services.plugin_publication_idempotency import (
    plugin_publication_idempotency_service,
)
from app.services.plugin_publication_service import plugin_publication_service

router = APIRouter(prefix="/plugins/publication-requests")


@router.get("", response_model=PluginPublicationRequestListResponse)
def list_plugin_publication_requests(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    publication_status: str | None = Query(default=None, alias="status"),
    risk_level: str | None = Query(default=None, alias="riskLevel"),
    submitter: str | None = Query(default=None),
    query: str | None = Query(default=None),
    submitted_after: datetime | None = Query(default=None, alias="submittedAfter"),
    submitted_before: datetime | None = Query(default=None, alias="submittedBefore"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginPublicationRequestListResponse:
    del current_user
    return plugin_publication_service.list_requests(
        db,
        user_id=None,
        is_admin=True,
        page=page,
        limit=limit,
        status=publication_status,
        risk_level=risk_level,
        submitter=submitter,
        query=query,
        submitted_after=submitted_after,
        submitted_before=submitted_before,
    )


@router.get("/{request_id}", response_model=PluginPublicationRequestDetail)
def get_plugin_publication_request(
    request_id: int,
    revision: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginPublicationRequestDetail:
    del current_user
    return plugin_publication_service.get_request(
        db,
        user_id=None,
        request_id=request_id,
        is_admin=True,
        revision_number=revision,
    )


@router.post("/{request_id}/return", response_model=PluginPublicationRequestDetail)
def return_plugin_publication_request(
    request_id: int,
    request: ReturnPluginPublicationRequest,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginPublicationRequestDetail:
    return plugin_publication_idempotency_service.execute(
        db,
        principal_type="admin",
        principal_id=current_user.id,
        operation="publication_request.return",
        idempotency_key=idempotency_key,
        resource_key=f"request:{request_id}:revision:{request.currentRevision}",
        payload=request,
        response_model=PluginPublicationRequestDetail,
        action=lambda: plugin_publication_service.return_request(
            db,
            admin_user=current_user,
            request_id=request_id,
            payload=request,
        ),
    )


@router.post("/{request_id}/accept", response_model=PluginPublicationRequestDetail)
def accept_plugin_publication_request(
    request_id: int,
    request: AcceptPluginPublicationRequest,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginPublicationRequestDetail:
    return plugin_publication_idempotency_service.execute(
        db,
        principal_type="admin",
        principal_id=current_user.id,
        operation="publication_request.accept",
        idempotency_key=idempotency_key,
        resource_key=f"request:{request_id}:revision:{request.currentRevision}",
        payload=request,
        response_model=PluginPublicationRequestDetail,
        action=lambda: plugin_publication_service.accept_request(
            db,
            admin_user=current_user,
            request_id=request_id,
            payload=request,
        ),
    )


@router.post("/{request_id}/reconcile", response_model=PluginPublicationRequestDetail)
def reconcile_plugin_publication_request(
    request_id: int,
    request: ReconcilePluginPublicationRequest,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=200
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginPublicationRequestDetail:
    return plugin_publication_idempotency_service.execute(
        db,
        principal_type="admin",
        principal_id=current_user.id,
        operation="publication_request.reconcile",
        idempotency_key=idempotency_key,
        resource_key=f"request:{request_id}:revision:{request.currentRevision}",
        payload=request,
        response_model=PluginPublicationRequestDetail,
        action=lambda: plugin_publication_service.reconcile_request(
            db,
            admin_user=current_user,
            request_id=request_id,
            payload=request,
        ),
    )
