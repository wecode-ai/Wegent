# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrative plugin mirror and submission review endpoints."""

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.installed_plugin import (
    PluginSubmissionItem,
    PluginSubmissionListResponse,
    PluginSubmissionReviewRequest,
    PluginUpstreamCreateRequest,
    PluginUpstreamItem,
    PluginUpstreamListResponse,
    PluginUpstreamUpdateRequest,
    PluginVisibilityGrantRequest,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service

router = APIRouter(prefix="/plugins")


@router.post("/{plugin_id}/visibility", status_code=status.HTTP_204_NO_CONTENT)
def grant_plugin_visibility(
    plugin_id: int,
    request: PluginVisibilityGrantRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> None:
    del current_user
    plugin_marketplace_service.grant_plugin_visibility(
        db,
        plugin_id=plugin_id,
        entity_type=request.entityType,
        entity_id=request.entityId,
    )


@router.get("/upstreams", response_model=PluginUpstreamListResponse)
def list_plugin_upstreams(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginUpstreamListResponse:
    del current_user
    return plugin_marketplace_service.list_upstreams(db)


@router.post(
    "/upstreams",
    response_model=PluginUpstreamItem,
    status_code=status.HTTP_201_CREATED,
)
def create_plugin_upstream(
    request: PluginUpstreamCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginUpstreamItem:
    del current_user
    return plugin_marketplace_service.create_upstream(db, request=request)


@router.patch("/upstreams/{upstream_id}", response_model=PluginUpstreamItem)
def update_plugin_upstream(
    upstream_id: int,
    request: PluginUpstreamUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginUpstreamItem:
    del current_user
    return plugin_marketplace_service.update_upstream_policy(
        db,
        upstream_id=upstream_id,
        sync_policy=request.syncPolicy,
    )


@router.post("/upstreams/{upstream_id}/sync", response_model=PluginUpstreamItem)
def sync_plugin_upstream(
    upstream_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginUpstreamItem:
    del current_user
    return plugin_marketplace_service.sync_upstream(db, upstream_id=upstream_id)


@router.get("/submissions", response_model=PluginSubmissionListResponse)
def list_plugin_submissions(
    submission_status: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginSubmissionListResponse:
    del current_user
    return plugin_marketplace_service.list_submissions(db, status=submission_status)


@router.post("/submissions/{submission_id}/review", response_model=PluginSubmissionItem)
def review_plugin_submission(
    submission_id: int,
    request: PluginSubmissionReviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> PluginSubmissionItem:
    return plugin_marketplace_service.review_submission(
        db,
        reviewer_user_id=current_user.id,
        submission_id=submission_id,
        approved=request.approved,
        note=request.note,
    )
