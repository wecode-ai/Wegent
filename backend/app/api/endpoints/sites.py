# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Backend proxy endpoints for the Sites service."""

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.core import security
from app.models.user import User
from app.schemas.site import SiteListResponse, SiteRenameRequest, SiteResponse
from app.services.sites import (
    SitesNotAvailableError,
    SitesUpstreamAuthenticationError,
    SitesUpstreamResponseError,
    SitesUpstreamUnavailableError,
    sites_service,
)

router = APIRouter()
SITES_ERRORS = (
    SitesNotAvailableError,
    SitesUpstreamAuthenticationError,
    SitesUpstreamUnavailableError,
    SitesUpstreamResponseError,
)


def _raise_sites_error(error: Exception) -> NoReturn:
    if isinstance(error, SitesNotAvailableError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "sites_not_available",
                "message": "Sites is not available yet",
            },
        ) from error
    if isinstance(error, SitesUpstreamAuthenticationError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "sites_upstream_auth_failed",
                "message": "Sites service authentication failed",
            },
        ) from error
    if isinstance(error, SitesUpstreamUnavailableError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "sites_upstream_unavailable",
                "message": "Sites service is unavailable",
            },
        ) from error
    if isinstance(error, SitesUpstreamResponseError):
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        ) from error
    raise error


@router.get("", response_model=SiteListResponse)
async def list_sites(
    q: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
) -> SiteListResponse:
    """Search projects owned by the authenticated user."""
    try:
        return await sites_service.list_sites(
            username=current_user.user_name,
            query=q.strip() if q else None,
            cursor=cursor,
            limit=limit,
        )
    except SITES_ERRORS as error:
        _raise_sites_error(error)


@router.post("/{project_id}/publish", response_model=SiteResponse)
async def publish_site(
    project_id: str,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Publish a project owned by the authenticated user."""
    try:
        return await sites_service.publish_site(
            current_user.user_name,
            project_id,
        )
    except SITES_ERRORS as error:
        _raise_sites_error(error)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_site(
    project_id: str,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Delete a project owned by the authenticated user."""
    try:
        await sites_service.delete_site(
            current_user.user_name,
            project_id,
        )
    except SITES_ERRORS as error:
        _raise_sites_error(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{project_id}/rename", response_model=SiteResponse)
async def rename_site(
    project_id: str,
    request: SiteRenameRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Rename a project owned by the authenticated user."""
    try:
        return await sites_service.rename_site(
            current_user.user_name,
            project_id,
            request.title,
        )
    except SITES_ERRORS as error:
        _raise_sites_error(error)
